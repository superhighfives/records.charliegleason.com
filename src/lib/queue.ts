import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { eq, ne } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record, records } from "#/db/schema";
import { analyzeCapture, findDuplicateOf } from "#/lib/analyze";
import { type AnalyzeMessage, toQueueBatches } from "#/lib/batching";
import {
	getMasterDetail,
	getReleaseDetail,
	getReleaseValue,
	searchMasters,
} from "#/lib/discogs";
import {
	type CoverStageResult,
	commitProfessionalMatte,
	generateProfessionalCover,
	type MatteKeys,
	renderAiMatte,
	renderDeterministicMatte,
} from "#/lib/professional-pipeline";

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
 * failed regeneration. Shared by both Apply stages (cover + matte). Best-effort.
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
			updatedAt: new Date(),
		})
		.where(eq(records.id, recordId))
		.catch(() => {});
}

/** Queue producer binding (typed loosely; the binding name lives in wrangler.jsonc). */
function analyzeQueue(): Queue<AnalyzeMessage> {
	return (env as unknown as { ANALYZE_QUEUE: Queue<AnalyzeMessage> })
		.ANALYZE_QUEUE;
}

/** Enqueue a captured record for background analysis. */
export async function enqueueAnalyze(recordId: number): Promise<void> {
	await analyzeQueue().send({ recordId });
}

/**
 * Enqueue a record for the paid Apply pipeline. Kicks off stage 1 (reframe + enhance);
 * that stage enqueues stage 2 (the AI matte) itself via {@link enqueueProfessionalMatte},
 * so each memory-heavy step runs in its own isolate.
 */
export async function enqueueProfessional(recordId: number): Promise<void> {
	await analyzeQueue().send({ recordId, mode: "professional" });
}

/**
 * Enqueue stage 2 of the Apply pipeline — the AI matte + final commit — carrying the
 * stage-1 result (cover key + the exact inputs it was built from) so the matte is cut
 * from the same snapshot and both swap in atomically. Called by the stage-1 consumer,
 * not the UI.
 */
export async function enqueueProfessionalMatte(
	recordId: number,
	stage: CoverStageResult,
): Promise<void> {
	await analyzeQueue().send({ recordId, mode: "professional-matte", ...stage });
}

/**
 * Enqueue the deterministic-matte fallback — stage 2b — after the AI matte failed. Runs
 * the (larger, ~3000² deskew) deterministic render in its OWN fresh isolate rather than
 * inline in the AI stage, then commits the same stage-1 cover with it. Carries the same
 * snapshot so the committed cover + matte stay cut from one set of inputs.
 */
export async function enqueueProfessionalMatteFallback(
	recordId: number,
	stage: CoverStageResult,
): Promise<void> {
	await analyzeQueue().send({
		recordId,
		mode: "professional-matte-fallback",
		...stage,
	});
}

/**
 * Enqueue many ids as `sendBatch` calls rather than one `send` per id — a bulk
 * "Match"/"Refresh"/"Rescan" over a large selection would otherwise fan out into
 * hundreds of individual queue writes (one subrequest each). {@link toQueueBatches}
 * chunks to the per-batch cap; `mode` picks the analyze (default) vs refresh pipeline.
 */
async function enqueueBatch(
	recordIds: number[],
	mode?: AnalyzeMessage["mode"],
): Promise<void> {
	for (const batch of toQueueBatches(recordIds, mode)) {
		await analyzeQueue().sendBatch(batch);
	}
}

/** Enqueue many captured records for background analysis. */
export function enqueueAnalyzeBatch(recordIds: number[]): Promise<void> {
	return enqueueBatch(recordIds);
}

/** Enqueue many published records to be re-pulled from their Discogs releases. */
export function enqueueRefreshBatch(recordIds: number[]): Promise<void> {
	return enqueueBatch(recordIds, "refresh");
}

/**
 * Re-pull a record from Discogs. Three paths by what's set:
 *  - pinned release → refresh enrichment (year, label, genre, format, size, catno,
 *    country) + a fresh value, and backfill the master link;
 *  - album-only (master, no release) → refresh album-level fields from the master;
 *  - neither → guess a master from the record's artist/title (the cover metadata).
 * Only overwrites a field when Discogs returns a value, so it never nulls good
 * data; a guess only sets the album identity and never publishes. Leaves
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

		// Value is best-effort — a missing/failed price lookup shouldn't block the
		// metadata refresh, so fetch it separately and keep the previous figure on miss.
		const value = await getReleaseValue(record.discogsId).catch(() => null);

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
				catno: detail.catno ?? record.catno,
				country: detail.country ?? record.country,
				...valueColumns(value),
				updatedAt: new Date(),
			})
			.where(eq(records.id, id))
			.returning();
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
		if (!best) return record;

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

	// Nothing to refresh or guess from (no Discogs link and no artist/title).
	return null;
}

/**
 * The value-related column updates for a fetched Discogs value. A miss (no
 * usable figure) returns no changes, so a transient failure leaves any
 * previously-fetched value untouched rather than wiping it. Shared by the
 * refresh path and the standalone value fetch.
 */
function valueColumns(value: Awaited<ReturnType<typeof getReleaseValue>>) {
	if (!value || value.value == null) return {};
	return {
		discogsValue: value.value,
		discogsValueCurrency: value.currency,
		discogsValueJson: value.suggestions
			? JSON.stringify(value.suggestions)
			: null,
		discogsValueFetchedAt: new Date(),
	};
}

/**
 * Fetch just the Discogs value estimate for a record and store it, leaving all
 * other metadata untouched. Returns the updated row, or null if the record is
 * gone or has no Discogs id to value.
 */
export async function fetchValueForRecord(id: number): Promise<Record | null> {
	const db = getDb(env.DB);
	const [record] = await db
		.select()
		.from(records)
		.where(eq(records.id, id))
		.limit(1);
	if (!record?.discogsId) return null;

	const value = await getReleaseValue(record.discogsId).catch(() => null);
	const cols = valueColumns(value);
	// Nothing usable came back — leave the record (and its `updatedAt`) untouched so
	// a failed fetch doesn't masquerade as a successful edit.
	if (Object.keys(cols).length === 0) return record;

	const [row] = await db
		.update(records)
		.set({ ...cols, updatedAt: new Date() })
		.where(eq(records.id, id))
		.returning();
	return row ?? record;
}

async function processMessage(message: Message<AnalyzeMessage>): Promise<void> {
	const { recordId, mode } = message.body;
	const db = getDb(env.DB);

	// Lightweight path: just re-pull the stored Discogs release. Best-effort —
	// a refresh failure shouldn't retry-storm or touch the record's status.
	if (mode === "refresh") {
		try {
			await refreshRecordById(recordId);
		} catch (err) {
			console.error(
				`[queue] refresh failed for record ${recordId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			Sentry.captureException(err);
		}
		message.ack();
		return;
	}

	// The paid Apply pipeline, stage 1 — reframe + Real-ESRGAN enhance (the cover).
	// Runs the cover in its own isolate, then hands the cover key to stage 2 (the AI
	// matte) via `enqueueProfessionalMatte` so the two memory-heavy Replicate steps
	// never share a 128 MB isolate. The display `professionalStatus` is left untouched
	// throughout (an already-live cover stays live); `professionalJobStatus` stays
	// `processing` across both stages so the header "in flight" menu and the editor keep
	// showing progress until stage 2 commits.
	if (mode === "professional") {
		try {
			const [record] = await db
				.update(records)
				.set({
					professionalJobStatus: "processing",
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

			const stage = await generateProfessionalCover(record);
			// Do NOT delete stage.coverKey if this throws: a queue `send` can fail on the
			// client (timed-out ack) after the message was actually accepted server-side.
			// Deleting the key then would leave that in-flight matte message committing
			// `professionalImageKey` = a *deleted* R2 object (a broken cover). So on a
			// throw we just retry stage 1, which mints a fresh cover key; the worst case
			// is a rare orphaned cover object (storage only), never a dangling reference.
			await enqueueProfessionalMatte(recordId, stage);
			message.ack();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const willRetry = message.attempts <= MAX_RETRIES;
			console.error(
				`[queue] professional (cover) failed for record ${recordId} (attempt ${message.attempts}, willRetry=${willRetry}): ${detail}`,
			);
			Sentry.captureException(err);
			await markProfessionalFailed(db, recordId, willRetry, detail);
			if (willRetry) {
				message.retry({ delaySeconds: backoffSeconds(message.attempts) });
			} else {
				message.ack();
			}
		}
		return;
	}

	// Stage 2 — the matte + the final atomic commit, in a fresh isolate (none of stage 1's
	// reframe/enhance residue). Two modes, so the AI attempt and its (larger) deterministic
	// fallback each get their OWN isolate — stacking a failed AI attempt's buffers with the
	// ~3000² deterministic deskew on one 128 MB isolate is what OOM'd:
	//   - "professional-matte": try the AI matte only (`renderAiMatte`, no inline fallback).
	//     On success, commit cover + AI matte. On failure, log the real error to Sentry and
	//     retry the AI stage until the queue's retries run out — only THEN re-enqueue the
	//     deterministic fallback to a clean isolate (we prefer AI; deterministic is a last
	//     resort, not the response to a transient blip).
	//   - "professional-matte-fallback": render the deterministic matte here and commit it
	//     (or, if it too fails, preserve the existing matte + flag `failed`).
	// The cover key + input snapshot from stage 1 rides on the message in both, so whichever
	// matte wins swaps in with the same cover atomically (no public gap).
	if (mode === "professional-matte" || mode === "professional-matte-fallback") {
		const isFallback = mode === "professional-matte-fallback";
		const { coverKey, enhanced, captureKey, bandJson, paramsJson } =
			message.body;
		try {
			const [record] = await db
				.update(records)
				.set({ professionalJobStatus: "processing", updatedAt: new Date() })
				.where(eq(records.id, recordId))
				.returning();

			// Deleted between stages — bin the orphaned (never-committed) cover key.
			if (!record) {
				if (coverKey) await env.PHOTOS.delete(coverKey).catch(() => {});
				message.ack();
				return;
			}
			if (
				!coverKey ||
				captureKey == null ||
				bandJson == null ||
				paramsJson == null
			) {
				throw new Error(
					"professional-matte message missing the stage-1 snapshot",
				);
			}
			const stage: CoverStageResult = {
				coverKey,
				enhanced: enhanced ?? false,
				captureKey,
				bandJson,
				paramsJson,
			};

			if (isFallback) {
				// The AI matte already failed for good (its retries were exhausted upstream)
				// — render the deterministic matte here on a clean heap. If it too dies,
				// commit the cover with the existing matte preserved and flag `failed` (both
				// paths gone → keep the good matte).
				let matteError: unknown = null;
				const matte = await renderDeterministicMatte(stage).catch((err) => {
					console.error(
						`[pro] deterministic matte failed for ${recordId}`,
						err,
					);
					Sentry.captureException(err);
					matteError = err;
					return null;
				});
				await commitProfessionalMatte(record, stage, matte, matteError);
				message.ack();
				return;
			}

			// AI matte only — no inline deterministic fallback (that would stack the two big
			// renders on one isolate). We PREFER the AI matte, so a failure isn't an
			// immediate downgrade: log the real error to Sentry and retry the AI stage
			// (backoff) until the queue's retries run out — the deterministic fallback is a
			// LAST resort, not the response to a transient Replicate/network blip.
			let aiMatte: MatteKeys;
			try {
				aiMatte = await renderAiMatte(stage);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				const willRetry = message.attempts <= MAX_RETRIES;
				console.warn(
					`[queue] AI matte failed for record ${recordId} (attempt ${message.attempts}, willRetry=${willRetry}): ${detail}`,
				);
				// Capture the ACTUAL AI failure (Replicate error, fetch status, OOM, …) —
				// otherwise the deterministic fallback silently masks why AI never ran.
				Sentry.captureException(err);
				if (willRetry) {
					// Keep trying AI — don't drop to deterministic yet.
					await markProfessionalFailed(db, recordId, true, detail);
					message.retry({ delaySeconds: backoffSeconds(message.attempts) });
					return;
				}
				// AI genuinely exhausted → last-resort deterministic fallback, fresh isolate.
				await enqueueProfessionalMatteFallback(recordId, stage);
				message.ack();
				return;
			}
			await commitProfessionalMatte(record, stage, aiMatte, null);
			message.ack();
			return;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const willRetry = message.attempts <= MAX_RETRIES;
			console.error(
				`[queue] professional (matte${isFallback ? " fallback" : ""}) failed for record ${recordId} (attempt ${message.attempts}, willRetry=${willRetry}): ${detail}`,
			);
			Sentry.captureException(err);
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
			.set({ status: "processing", error: null, updatedAt: new Date() })
			.where(eq(records.id, recordId))
			.returning();

		// Deleted between enqueue and delivery — nothing to do.
		if (!record) {
			message.ack();
			return;
		}

		const result = await analyzeCapture(record);

		if (!result.masterId) {
			// Identified the sleeve but couldn't attach a Discogs album (master) —
			// either a genuine gap in Discogs or a transient failure that outlived the
			// retries. Surface it so "Unmatched" records are observable rather than
			// silently landing in review with no album linked. A stable fingerprint
			// rolls every unmatched record into a single issue instead of spawning a
			// fresh one per record; the specifics ride along as per-event context.
			Sentry.withScope((scope) => {
				scope.setLevel("warning");
				scope.setFingerprint(["analyze-no-discogs-match"]);
				scope.setContext("record", {
					id: recordId,
					artist: result.artist,
					title: result.title,
				});
				Sentry.captureMessage("[analyze] no Discogs album match for record");
			});
		}

		// Flag the record if the collection already holds this album. Compared
		// against every other row (the capture itself is excluded by id), matching
		// on Discogs master first, then release, then normalized artist + title.
		const others = await db
			.select({
				id: records.id,
				artist: records.artist,
				title: records.title,
				masterId: records.masterId,
				discogsId: records.discogsId,
			})
			.from(records)
			.where(ne(records.id, recordId));
		const duplicateOf = findDuplicateOf(
			{
				artist: result.artist,
				title: result.title,
				masterId: result.masterId,
				discogsId: result.discogsId,
			},
			others,
		);

		await db
			.update(records)
			.set({
				artist: result.artist || "Unknown artist",
				title: result.title || "Untitled",
				year: result.year,
				label: result.label,
				format: result.format ?? "LP",
				size: result.size,
				catno: result.catno,
				country: result.country,
				genre: result.genre,
				pitchforkScore: result.pitchforkScore,
				pitchforkUrl: result.pitchforkUrl,
				masterId: result.masterId,
				masterUrl: result.masterUrl,
				discogsId: result.discogsId,
				discogsUrl: result.discogsUrl,
				coverImageKey: result.coverImageKey,
				confidence: result.confidence,
				candidatesJson: JSON.stringify(result.candidates),
				duplicateOf,
				status: "review",
				error: null,
				updatedAt: new Date(),
			})
			.where(eq(records.id, recordId));

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

		await db
			.update(records)
			.set({
				status: willRetry ? "pending" : "failed",
				error: detail,
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
