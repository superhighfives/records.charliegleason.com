import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "#/db";
import { type JobStep, type Record, records } from "#/db/schema";
import { analyzeCapture } from "#/lib/analyze";
import {
	type AnalyzeMessage,
	type AnalyzeRecordMessage,
	chunk,
	D1_PARAM_CHUNK,
	toQueueBatches,
} from "#/lib/batching";
import { runCaptureFirstPass } from "#/lib/capture-first-pass";
import { generateColorTexture } from "#/lib/color-texture";
import {
	getMasterDetail,
	getReleaseDetail,
	getReleaseValue,
	searchMasters,
	searchReleases,
} from "#/lib/discogs";
import { logJobEvent } from "#/lib/job-events";
import { applyProfessional } from "#/lib/professional-pipeline";
import { formatMoney } from "#/lib/value";

/**
 * Background analysis via a Cloudflare Queue. Capturing a record inserts a
 * `pending` row and enqueues its id here; the consumer (wired in src/server.ts)
 * runs the AI pipeline and moves the row to `review`, or `failed` after the
 * queue's retries are exhausted. The DLQ catches anything that still fails.
 */

export type { AnalyzeMessage } from "#/lib/batching";

/** `max_retries` from wrangler.jsonc — used only to label the row once retries run out. */
const MAX_RETRIES = 3;

/**
 * Exponential backoff (15s, 30s, 60s) so a transient rate-limit / exhausted-AI-credit
 * blip has room to clear before we retry, instead of burning all attempts in one window.
 */
function backoffSeconds(attempts: number): number {
	return Math.min(60, 15 * 2 ** (attempts - 1));
}

/**
 * Flag a professional (Apply) job failed on the row. Only `professionalJobStatus` flips —
 * the display `professionalStatus` is preserved so an already-approved cover survives a
 * failed regeneration. Best-effort.
 */
async function markProfessionalFailed(
	db: ReturnType<typeof getDb>,
	recordId: number,
	willRetry: boolean,
	detail: string,
): Promise<void> {
	await db
		.update(records)
		.set({
			professionalJobStatus: willRetry ? "queued" : "failed",
			professionalError: detail,
			// Terminal (failed) or headed back to the queue (a re-enqueue restarts at
			// reframe) — either way the current sub-step no longer applies.
			jobStep: null,
			updatedAt: new Date(),
		})
		.where(eq(records.id, recordId))
		.catch(() => {});
}

/**
 * Stamp the current display-only sub-step on the row (see `records.jobStep`) so the header
 * queue can show "(2/4) Enhancing" etc. Best-effort and non-fatal — a missed write just
 * leaves the menu on the previous step for another poll. Bumps `updatedAt` too, so a long
 * step that's actively progressing doesn't drift toward the reaper's stale-job threshold.
 */
async function setJobStep(
	db: ReturnType<typeof getDb>,
	recordId: number,
	step: JobStep,
): Promise<void> {
	await db
		.update(records)
		.set({ jobStep: step, updatedAt: new Date() })
		.where(eq(records.id, recordId))
		.catch(() => {});
}

/** Queue producer binding (typed loosely; the binding name lives in wrangler.jsonc). */
function analyzeQueue(): Queue<AnalyzeMessage> {
	return (env as unknown as { ANALYZE_QUEUE: Queue<AnalyzeMessage> })
		.ANALYZE_QUEUE;
}

/**
 * The capture-only queue (see wrangler.jsonc `queues`). New-upload analysis rides its
 * own queue so a bulk Apply batch churning on `records-analyze` can't starve a fresh
 * capture; both feed the same consumer, which dispatches by message mode.
 */
function captureQueue(): Queue<AnalyzeMessage> {
	return (env as unknown as { CAPTURE_QUEUE: Queue<AnalyzeMessage> })
		.CAPTURE_QUEUE;
}

/** Enqueue a captured record for background analysis (its own queue — see {@link captureQueue}). */
export async function enqueueAnalyze(recordId: number): Promise<void> {
	await captureQueue().send({ recordId });
}

/**
 * Enqueue the free first-pass professional photo for a fresh/replaced capture
 * (see `runCaptureFirstPass`). Rides the capture lane: it's part of the
 * fresh-upload experience, so a bulk Apply batch churning on `records-analyze`
 * shouldn't delay it.
 */
export async function enqueueCaptureFirstPass(recordId: number): Promise<void> {
	await captureQueue().send({ recordId, mode: "capture-first-pass" });
}

/**
 * Enqueue a color for its reference vinyl texture to be (re)generated via Replicate.
 * Fired automatically on genuinely-new colors (see `getOrCreateColor`, used by
 * `createColor`, `createRecord`, and `captureRecord`), and manually from the
 * "regenerate" affordance in the color combobox.
 */
export async function enqueueColorTexture(colorId: number): Promise<void> {
	await analyzeQueue().send({ mode: "color-texture", colorId });
}

/** Enqueue a record for Apply — re-warp its square from the stored corners and go live. */
export async function enqueueProfessional(recordId: number): Promise<void> {
	await analyzeQueue().send({ recordId, mode: "professional" });
}

/**
 * How long a replaced cover stays in R2 before it's deleted — long enough for any open
 * page holding the old key (e.g. the collection, mid "Re-apply all") to finish with it.
 */
const STALE_PHOTO_GRACE_SECONDS = 60 * 60;

/**
 * Delete R2 objects after {@link STALE_PHOTO_GRACE_SECONDS} instead of immediately (see
 * `DeletePhotosMessage`). If the send itself fails, deletes now — an occasional broken
 * stale page beats an orphaned object nothing will ever clean up.
 */
export async function enqueueDeletePhotos(keys: string[]): Promise<void> {
	if (keys.length === 0) return;
	try {
		await analyzeQueue().send(
			{ mode: "delete-photos", keys },
			{ delaySeconds: STALE_PHOTO_GRACE_SECONDS },
		);
	} catch (err) {
		console.error("[queue] couldn't defer photo deletion, deleting now", err);
		await env.PHOTOS.delete(keys).catch(() => {});
	}
}

/**
 * Enqueue many ids as `sendBatch` calls rather than one `send` per id — a bulk
 * action over a large selection would otherwise fan out into hundreds of
 * individual queue writes (one subrequest each). {@link toQueueBatches} chunks to
 * the per-batch cap.
 */
async function enqueueBatch(
	recordIds: number[],
	mode?: AnalyzeRecordMessage["mode"],
): Promise<void> {
	for (const batch of toQueueBatches(recordIds, mode)) {
		await analyzeQueue().sendBatch(batch);
	}
}

/**
 * Bulk variant of {@link enqueueProfessional}, in chunked `sendBatch` calls rather than
 * one `send` per id, so a bulk "Retry generation" over a large selection doesn't fan out
 * into hundreds of individual queue writes.
 */
export function enqueueProfessionalBatch(recordIds: number[]): Promise<void> {
	return enqueueBatch(recordIds, "professional");
}

/**
 * Queue a Discogs value fetch for a record's pinned pressing. Best-effort and never
 * throws: callers fire it after an identity write, and a failed send must not undo
 * that write. A miss leaves the record for the bulk "fetch missing values" action.
 */
export async function enqueueValue(recordId: number): Promise<void> {
	try {
		await getDb(env.DB)
			.update(records)
			.set({ discogsValueQueuedAt: new Date() })
			.where(eq(records.id, recordId));
		await analyzeQueue().send({ recordId, mode: "value" });
	} catch (err) {
		console.error(`[queue] could not queue a value fetch for ${recordId}`, err);
		Sentry.captureException(err);
	}
}

/** Bulk variant of {@link enqueueValue}, in chunked `sendBatch` calls. */
export async function enqueueValueBatch(recordIds: number[]): Promise<void> {
	const db = getDb(env.DB);
	const now = new Date();
	for (const ids of chunk(recordIds, D1_PARAM_CHUNK)) {
		await db
			.update(records)
			.set({ discogsValueQueuedAt: now })
			.where(inArray(records.id, ids));
	}
	await enqueueBatch(recordIds, "value");
}

/**
 * Re-pull a record from Discogs. Three paths by what's set:
 *  - pinned release → refresh enrichment (year, label, genre, format, size, catno,
 *    country) + a fresh value, and backfill the master link;
 *  - album-only (master, no release) → refresh album-level fields from the master;
 *  - neither → guess an identity from the record's artist/title (the cover
 *    metadata): a master first, falling back to a release when no master group
 *    matches (some Discogs releases have none).
 * Only overwrites a field when Discogs returns a value, so it never nulls good
 * data; a guess only sets the identity (and gap-fills enrichment) and never
 * publishes. Leaves
 * artist/title/status alone. Returns the updated row, or null if the record is
 * gone or there's nothing to refresh/guess from. Shared by the sync `refreshRecord`
 * server fn and the bulk queue.
 */
export async function refreshRecordById(id: number): Promise<Record | null> {
	const db = getDb(env.DB);
	const [record] = await db
		.select()
		.from(records)
		.where(eq(records.id, id))
		.limit(1);
	if (!record) return null;

	// Pinned to a specific release → refresh the full release detail + value, and
	// backfill the master link while we're here (helps older rows gain their master).
	if (record.discogsId) {
		const detail = await getReleaseDetail(record.discogsId);
		if (!detail) return record;

		const [row] = await db
			.update(records)
			.set({
				masterId: detail.masterId ?? record.masterId,
				masterUrl: detail.masterUrl ?? record.masterUrl,
				year: detail.year ?? record.year,
				label: detail.label ?? record.label,
				genre: detail.genre ?? record.genre,
				format: detail.type ?? record.format,
				size: detail.size ?? record.size,
				discCount: detail.discCount ?? record.discCount,
				catno: detail.catno ?? record.catno,
				country: detail.country ?? record.country,
				updatedAt: new Date(),
			})
			.where(eq(records.id, id))
			.returning();
		// Refresh the value in the background, where a rate limit gets retried.
		await enqueueValue(id);
		return row ?? record;
	}

	// Album-only → refresh the album-level fields from the master. No pressing-specific
	// fields (catno/country/size/format) and no value — those need a pinned release.
	if (record.masterId) {
		const master = await getMasterDetail(record.masterId);
		if (!master) return record;

		const [row] = await db
			.update(records)
			.set({
				year: master.year ?? record.year,
				genre: master.genre ?? record.genre,
				updatedAt: new Date(),
			})
			.where(eq(records.id, id))
			.returning();
		return row ?? record;
	}

	// Neither a release nor a master yet → guess the album (master) from the
	// artist/title read off the cover, so a bulk Refresh seeds best-guess masters
	// for the collector to confirm. A guess only sets the album identity (and fills
	// empty year/genre) — it never publishes; the record stays in review until the
	// collector vouches for it. Needs at least an artist or title to search on.
	if (record.artist || record.title) {
		const hits = await searchMasters(
			{
				artist: record.artist,
				title: record.title,
				country: "",
				year: "",
				q: "",
			},
			5,
		).catch(() => []);
		const best = hits[0];
		if (best) {
			const [row] = await db
				.update(records)
				.set({
					masterId: best.masterId,
					masterUrl: best.masterUrl,
					// Gap-fill only — never overwrite curated values with a guess.
					year: record.year ?? best.year,
					genre: record.genre ?? best.genre,
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();
			return row ?? record;
		}

		// No master group matched — some Discogs releases have none. Fall back to a
		// release guess so the record can still gain an identity to confirm.
		const releaseHits = await searchReleases(
			{
				artist: record.artist,
				title: record.title,
				country: "",
				year: "",
				q: "",
			},
			5,
		).catch(() => []);
		const bestRelease = releaseHits[0];
		if (!bestRelease) return record;

		const [row] = await db
			.update(records)
			.set({
				discogsId: bestRelease.discogsId,
				discogsUrl: bestRelease.discogsUrl,
				masterId: bestRelease.masterId ?? record.masterId,
				masterUrl: bestRelease.masterUrl ?? record.masterUrl,
				// Gap-fill only — never overwrite curated values with a guess.
				year: record.year ?? bestRelease.year,
				genre: record.genre ?? bestRelease.genre,
				label: record.label ?? bestRelease.label,
				catno: record.catno ?? bestRelease.catno,
				country: record.country ?? bestRelease.country,
				format: record.format ?? bestRelease.type,
				size: record.size ?? bestRelease.size,
				discCount: record.discCount ?? bestRelease.discCount,
				updatedAt: new Date(),
			})
			.where(eq(records.id, id))
			.returning();
		await enqueueValue(id);
		return row ?? record;
	}

	// Nothing to refresh or guess from (no Discogs link and no artist/title).
	return null;
}

/**
 * The value columns to clear when a record's pressing changes: the stored figure
 * priced a different release, so it must not count toward the collection total.
 */
export const CLEARED_VALUE = {
	discogsValue: null,
	discogsValueCurrency: null,
	discogsValueJson: null,
	discogsValueFetchedAt: null,
	discogsValueQueuedAt: null,
} as const;

/**
 * Fetch the Discogs value estimate for a record's pinned pressing and store it,
 * leaving all other metadata untouched. Returns the updated row, or null if the
 * record is gone or has no pressing to value. A release with nothing to price
 * (no suggestions, nothing for sale) still stamps `discogsValueFetchedAt`, so the
 * bulk "fetch missing values" action doesn't re-queue it forever; any previous
 * figure stays. Discogs failures (rate limit, auth, network) throw, so the queue
 * can retry them and the editor can show them.
 */
export async function fetchValueForRecord(id: number): Promise<Record | null> {
	const db = getDb(env.DB);
	const [record] = await db
		.select()
		.from(records)
		.where(eq(records.id, id))
		.limit(1);
	if (!record?.discogsId) {
		if (record) await clearValueQueued(id);
		return null;
	}

	const value = await getReleaseValue(record.discogsId);
	const now = new Date();
	const [row] = await db
		.update(records)
		.set(
			value?.value != null
				? {
						discogsValue: value.value,
						discogsValueCurrency: value.currency,
						discogsValueJson: value.suggestions
							? JSON.stringify(value.suggestions)
							: null,
						discogsValueFetchedAt: now,
						discogsValueQueuedAt: null,
						updatedAt: now,
					}
				: { discogsValueFetchedAt: now, discogsValueQueuedAt: null },
		)
		// The pressing could change while the request was in flight; a figure for
		// the old one must not land on the new one.
		.where(and(eq(records.id, id), eq(records.discogsId, record.discogsId)))
		.returning();
	return row ?? record;
}

function clearValueQueued(id: number) {
	return getDb(env.DB)
		.update(records)
		.set({ discogsValueQueuedAt: null })
		.where(eq(records.id, id));
}

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

// Every record mode this consumer handles. The mapped type makes a new mode fail
// typecheck until it is listed here.
const RECORD_MODES: {
	[M in NonNullable<AnalyzeRecordMessage["mode"]>]: true;
} = {
	analyze: true,
	"capture-first-pass": true,
	professional: true,
	value: true,
};

async function processMessage(message: Message<AnalyzeMessage>): Promise<void> {
	// Colors-keyed job — handled entirely separately from the records pipeline below.
	if (message.body.mode === "color-texture") {
		const { colorId } = message.body;
		try {
			await generateColorTexture(colorId);
			await logJobEvent(
				"color",
				"info",
				null,
				`Made the texture for color ${colorId}`,
			);
		} catch (err) {
			await logJobEvent(
				"color",
				"error",
				null,
				`Texture for color ${colorId} failed: ${errorText(err)}`,
			);
			console.error(
				`[queue] color-texture failed for color ${colorId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			Sentry.captureException(err);
		}
		message.ack();
		return;
	}

	// Deferred R2 cleanup (see `enqueueDeletePhotos`). Deleting a missing key is a no-op,
	// so a redelivery is harmless; a failure retries with backoff, then gives up (an
	// orphaned object costs storage, nothing else).
	if (message.body.mode === "delete-photos") {
		try {
			await env.PHOTOS.delete(message.body.keys);
			message.ack();
		} catch (err) {
			console.error("[queue] delete-photos failed", err);
			if (message.attempts <= MAX_RETRIES) {
				message.retry({ delaySeconds: backoffSeconds(message.attempts) });
			} else {
				message.ack();
			}
		}
		return;
	}

	const { recordId, mode } = message.body;
	// A retired mode (still queued at deploy time, or replayed from the DLQ) must not
	// fall through to a full re-analysis of a published record.
	if (mode !== undefined && !Object.hasOwn(RECORD_MODES, mode)) {
		console.warn(`[queue] dropped unknown mode ${mode} for record ${recordId}`);
		message.ack();
		return;
	}
	const db = getDb(env.DB);

	// The free on-capture professional seed (see `capture-first-pass.ts` for why it
	// can't run inline in the capture POST). Records its own failure and never
	// throws — always ack.
	if (mode === "capture-first-pass") {
		await runCaptureFirstPass(recordId);
		message.ack();
		return;
	}

	// Discogs value fetch. Retried with backoff (a burst of these can trip Discogs'
	// 60 req/min limit), and never touches the record's status on failure.
	if (mode === "value") {
		try {
			const row = await fetchValueForRecord(recordId);
			if (row) {
				await logJobEvent(
					"value",
					"info",
					recordId,
					row.discogsValue != null
						? `${formatMoney(row.discogsValue, row.discogsValueCurrency ?? "USD")} on Discogs`
						: "Nothing for sale on Discogs",
				);
			}
			message.ack();
		} catch (err) {
			const willRetry = message.attempts <= MAX_RETRIES;
			console.error(
				`[queue] value failed for record ${recordId} (attempt ${message.attempts}, willRetry=${willRetry}): ${errorText(err)}`,
			);
			await logJobEvent(
				"value",
				"error",
				recordId,
				`${errorText(err)} (attempt ${message.attempts}, ${willRetry ? "will retry" : "gave up"})`,
			);
			if (willRetry) {
				message.retry({ delaySeconds: backoffSeconds(message.attempts) });
			} else {
				Sentry.captureException(err);
				await clearValueQueued(recordId).catch(() => {});
				message.ack();
			}
		}
		return;
	}

	// Apply — re-warp the square and promote it. The display `professionalStatus` is
	// left untouched until the commit (an already-live cover stays live), while
	// `professionalJobStatus` shows the job in the header "in flight" menu.
	if (mode === "professional") {
		try {
			const [record] = await db
				.update(records)
				.set({
					professionalJobStatus: "processing",
					professionalStage: "cover",
					jobStep: "reframe",
					professionalError: null,
					updatedAt: new Date(),
				})
				.where(eq(records.id, recordId))
				.returning();

			// Deleted between enqueue and delivery — nothing to do.
			if (!record) {
				message.ack();
				return;
			}

			const { staleKeys } = await applyProfessional(record);
			await enqueueDeletePhotos(staleKeys);
			await logJobEvent("professional", "info", recordId, "Applied the cover");
			message.ack();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const willRetry = message.attempts <= MAX_RETRIES;
			console.error(
				`[queue] professional failed for record ${recordId} (attempt ${message.attempts}, willRetry=${willRetry}): ${detail}`,
			);
			Sentry.captureException(err);
			await logJobEvent(
				"professional",
				"error",
				recordId,
				`Apply failed: ${detail} (attempt ${message.attempts}, ${willRetry ? "will retry" : "gave up"})`,
			);
			await markProfessionalFailed(db, recordId, willRetry, detail);
			if (willRetry) {
				message.retry({ delaySeconds: backoffSeconds(message.attempts) });
			} else {
				message.ack();
			}
		}
		return;
	}

	try {
		const [record] = await db
			.update(records)
			.set({
				status: "processing",
				error: null,
				// First visible sub-step; the rest follow via the callback below.
				jobStep: "reading",
				updatedAt: new Date(),
			})
			.where(eq(records.id, recordId))
			.returning();

		// Deleted between enqueue and delivery — nothing to do.
		if (!record) {
			message.ack();
			return;
		}

		const result = await analyzeCapture(record, (step) =>
			setJobStep(db, recordId, step),
		);

		if (!result.masterId && !result.discogsId) {
			// Identified the sleeve but couldn't attach a Discogs identity — neither
			// an album (master) nor a release matched, either a genuine gap in
			// Discogs or a transient failure that outlived the retries. Surface it so
			// "Unmatched" records are observable rather than silently landing in
			// review with nothing linked. A stable fingerprint rolls every unmatched
			// record into a single issue instead of spawning a fresh one per record;
			// the specifics ride along as per-event context.
			Sentry.withScope((scope) => {
				scope.setLevel("warning");
				scope.setFingerprint(["analyze-no-discogs-match"]);
				scope.setContext("record", {
					id: recordId,
					artist: result.artist,
					title: result.title,
				});
				Sentry.captureMessage("[analyze] no Discogs match for record");
			});
		}

		await db
			.update(records)
			.set({
				artist: result.artist || "Unknown artist",
				title: result.title || "Untitled",
				year: result.year,
				label: result.label,
				format: result.format ?? "LP",
				size: result.size,
				discCount: result.discCount,
				catno: result.catno,
				country: result.country,
				genre: result.genre,
				pitchforkScore: result.pitchforkScore,
				pitchforkUrl: result.pitchforkUrl,
				masterId: result.masterId,
				masterUrl: result.masterUrl,
				discogsId: result.discogsId,
				discogsUrl: result.discogsUrl,
				...(result.discogsId !== record.discogsId ? CLEARED_VALUE : {}),
				coverImageKey: result.coverImageKey,
				confidence: result.confidence,
				candidatesJson: JSON.stringify(result.candidates),
				status: "review",
				error: null,
				// Analysis landed — clear the progress marker + the reaper's auto-retry budget.
				jobStep: null,
				analyzeRetryCount: 0,
				updatedAt: new Date(),
			})
			.where(eq(records.id, recordId));
		if (result.discogsId && result.discogsId !== record.discogsId) {
			await enqueueValue(recordId);
		}
		await logJobEvent(
			"analyze",
			result.masterId || result.discogsId ? "info" : "error",
			recordId,
			result.masterId || result.discogsId
				? `Read as ${result.artist} — ${result.title}`
				: `Read as ${result.artist} — ${result.title}, but found no Discogs match`,
		);

		message.ack();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		// `message.attempts` is 1 on first delivery; retry until the queue's limit,
		// then give up and surface the error on the record for a manual retry.
		const willRetry = message.attempts <= MAX_RETRIES;
		console.error(
			`[queue] analyze failed for record ${recordId} (attempt ${message.attempts}, willRetry=${willRetry}): ${detail}`,
		);
		Sentry.captureException(err);
		await logJobEvent(
			"analyze",
			"error",
			recordId,
			`Analysis failed: ${detail} (attempt ${message.attempts}, ${willRetry ? "will retry" : "gave up"})`,
		);

		await db
			.update(records)
			.set({
				status: willRetry ? "pending" : "failed",
				error: detail,
				// Terminal (failed) or headed back to the queue (a retry restarts at reading)
				// — either way the current sub-step no longer applies.
				jobStep: null,
				updatedAt: new Date(),
			})
			.where(eq(records.id, recordId))
			.catch(() => {});

		if (willRetry) {
			// Exponential backoff (15s, 30s, 60s) so a transient rate-limit or
			// exhausted-AI-credit blip has room to clear before we retry, instead of
			// burning all three attempts inside the same throttled window.
			const delaySeconds = Math.min(60, 15 * 2 ** (message.attempts - 1));
			message.retry({ delaySeconds });
		} else {
			message.ack();
		}
	}
}

/** Queue consumer entry — processes one capture per message. */
export async function handleAnalyzeBatch(
	batch: MessageBatch<AnalyzeMessage>,
): Promise<void> {
	for (const message of batch.messages) {
		await processMessage(message);
	}
}
