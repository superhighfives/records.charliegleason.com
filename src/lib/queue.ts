import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { eq, inArray } from "drizzle-orm";

import { getDb } from "#/db";
import {
	type JobStep,
	matteAuditState,
	type Record,
	records,
} from "#/db/schema";
import { analyzeCapture } from "#/lib/analyze";
import { identifyFromAsin } from "#/lib/asin";
import {
	type AnalyzeMessage,
	type AnalyzeRecordMessage,
	chunk,
	nextMatteAction,
	QUEUE_BATCH_SIZE,
	toQueueBatches,
} from "#/lib/batching";
import {
	extractStoredColorPalette,
	generateColorTexture,
} from "#/lib/color-texture";
import {
	getMasterDetail,
	getReleaseDetail,
	getReleaseValue,
	searchByBarcode,
	searchMasters,
	searchReleases,
} from "#/lib/discogs";
import { stepMatteAuditSweep } from "#/lib/matte-audit";
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
 * own queue so a bulk Apply/enhance batch churning on `records-analyze` can't starve a
 * fresh capture; both feed the same consumer, which dispatches by message mode. Falls
 * back to the analyze queue where the binding isn't deployed yet (one deploy's worth of
 * config skew — the message is identical either way, this only picks the lane).
 */
function captureQueue(): Queue<AnalyzeMessage> {
	const bindings = env as unknown as {
		CAPTURE_QUEUE?: Queue<AnalyzeMessage>;
		ANALYZE_QUEUE: Queue<AnalyzeMessage>;
	};
	return bindings.CAPTURE_QUEUE ?? bindings.ANALYZE_QUEUE;
}

/** Enqueue a captured record for background analysis (its own queue — see {@link captureQueue}). */
export async function enqueueAnalyze(recordId: number): Promise<void> {
	await captureQueue().send({ recordId });
}

/** Enqueue one batch of the background matte-quality audit sweep. */
export async function enqueueAuditMattes(): Promise<void> {
	await analyzeQueue().send({ mode: "audit-mattes" });
}

/**
 * Enqueue Amazon ASIN→pressing resolutions in bulk (the importer's "queue
 * lookups"). Each message barcode-resolves one ASIN and pins the exact pressing on
 * its record in the background. Sent in batches (Cloudflare caps `sendBatch` at
 * 100) so hundreds of lookups don't need hundreds of round-trips.
 */
export async function enqueueResolveAsinBatch(
	jobs: Array<{ recordId: number; asin: string; country: string | null }>,
): Promise<void> {
	const db = getDb(env.DB);
	const queue = analyzeQueue();
	for (const slice of chunk(jobs, 100)) {
		await queue.sendBatch(
			slice.map((job) => ({ body: { mode: "resolve-asin", ...job } })),
		);
		// Mark queued only after the send confirms — so a failed sendBatch doesn't
		// leave a row flagged "queued" with nothing actually in flight (the importer's
		// matching filter would then wrongly hide it forever). This is also what lets
		// the header queue menu show these jobs, and what stops a re-uploaded CSV from
		// re-offering a purchase that's already in flight.
		await db
			.update(records)
			.set({
				amazonResolveStatus: "queued",
				amazonResolveError: null,
				updatedAt: new Date(),
			})
			.where(
				inArray(
					records.id,
					slice.map((job) => job.recordId),
				),
			);
	}
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

/**
 * Enqueue a palette-only re-extraction from a color's existing texture — no
 * Replicate call (see `extractStoredColorPalette`). Used by `backfillColorPalettes`
 * to fill in palettes for colors whose texture predates the `palette` column.
 */
export async function enqueueColorPalette(colorId: number): Promise<void> {
	await analyzeQueue().send({ mode: "color-palette", colorId });
}

/**
 * Enqueue a record for the paid Apply pipeline. Kicks off stage 1 (reframe + enhance);
 * that stage enqueues stage 2 (the Magic matte) itself via {@link enqueueProfessionalMatte},
 * so each memory-heavy step runs in its own isolate.
 */
export async function enqueueProfessional(recordId: number): Promise<void> {
	await analyzeQueue().send({ recordId, mode: "professional" });
}

/**
 * Enqueue stage 2 of the Apply pipeline — the Magic matte + final commit — carrying the
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
 * Bulk variant of {@link enqueueProfessional} — kicks the full Apply pipeline (stage 1
 * cover → stage 2 matte) for many records in chunked `sendBatch` calls rather than one
 * `send` per id, so a bulk "Retry generation" over a large selection doesn't fan out into
 * hundreds of individual queue writes.
 */
export function enqueueProfessionalBatch(recordIds: number[]): Promise<void> {
	return enqueueBatch(recordIds, "professional");
}

/**
 * Bulk variant of {@link enqueueProfessionalMatte} — re-runs ONLY stage 2 (the Magic matte +
 * commit) for many records, each carrying its own stage-1 snapshot, in chunked `sendBatch`
 * calls. Used by the admin "Retry Magic matte" bulk action. Unlike {@link enqueueBatch}, the
 * bodies differ per record (each has its own cover snapshot), so it can't go through the
 * id-only {@link toQueueBatches} path; it chunks the pre-built messages here.
 */
export async function enqueueProfessionalMatteBatch(
	items: Array<{ recordId: number; stage: CoverStageResult }>,
): Promise<void> {
	const messages = items.map(({ recordId, stage }) => ({
		body: { recordId, mode: "professional-matte" as const, ...stage },
	}));
	for (const batch of chunk(messages, QUEUE_BATCH_SIZE)) {
		await analyzeQueue().sendBatch(batch);
	}
}

/**
 * Enqueue the deterministic-matte fallback — stage 2b — after the Magic matte failed. Runs
 * the (larger, ~3000² deskew) deterministic render in its OWN fresh isolate rather than
 * inline in the AI stage, then commits the same stage-1 cover with it. Carries the same
 * snapshot so the committed cover + matte stay cut from one set of inputs, plus the AI
 * failure reason so a successful fallback can still surface it in the admin UI.
 */
export async function enqueueProfessionalMatteFallback(
	recordId: number,
	stage: CoverStageResult,
	aiMatteError: string,
): Promise<void> {
	await analyzeQueue().send({
		recordId,
		mode: "professional-matte-fallback",
		...stage,
		aiMatteError,
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
	mode?: AnalyzeRecordMessage["mode"],
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
				discCount: detail.discCount ?? record.discCount,
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

/**
 * Resolve an Amazon ASIN to its exact Discogs pressing and pin it on the record.
 * Reads the barcode off the product page (web search), looks it up on Discogs, and
 * pins the best-matching release — preferring one that belongs to the record's
 * existing master, then the marketplace country. Conservative on purpose: never
 * overwrites an already-pinned release, and never pins a release from a *different*
 * master than the record already has (that would leave an inconsistent state) —
 * those are left for a human. Best-effort; logs and returns on any miss.
 */
async function resolveAsinForRecord(
	recordId: number,
	asin: string,
	preferCountry: string | null,
): Promise<void> {
	const db = getDb(env.DB);
	const [record] = await db
		.select()
		.from(records)
		.where(eq(records.id, recordId))
		.limit(1);
	if (!record) return;
	// Already pinned — don't clobber a pressing a human (or a prior job) chose. Clear
	// the queued flag regardless, so a stale "queued" doesn't linger on an already-done
	// record (e.g. a human pinned it manually while this job was in flight).
	if (record.discogsId) {
		console.info(
			`[queue] resolve-asin ${asin}: record ${recordId} already has a release`,
		);
		await db
			.update(records)
			.set({ amazonResolveStatus: "idle", amazonResolveError: null })
			.where(eq(records.id, recordId));
		return;
	}

	const fail = async (reason: string) => {
		console.info(`[queue] resolve-asin ${asin}: ${reason}`);
		await db
			.update(records)
			.set({ amazonResolveStatus: "failed", amazonResolveError: reason })
			.where(eq(records.id, recordId));
	};

	const identity = await identifyFromAsin(asin);
	if (!identity?.barcode) {
		await fail("no barcode found on the Amazon listing");
		return;
	}
	const releases = await searchByBarcode(identity.barcode).catch(() => []);
	if (releases.length === 0) {
		await fail(`barcode ${identity.barcode} matched no Discogs release`);
		return;
	}

	// Only pin a release consistent with the record's identity: if it already has a
	// master, the pressing must belong to that master; otherwise adopt the pressing's.
	const consistent = record.masterId
		? releases.filter((r) => r.masterId === record.masterId)
		: releases;
	if (consistent.length === 0) {
		await fail(
			`barcode ${identity.barcode} matched a release, but not this record's album — leaving for manual review`,
		);
		return;
	}
	// Prefer the pressing from the marketplace's country, else the first hit.
	const chosen =
		(preferCountry &&
			consistent.find(
				(r) => r.country?.toLowerCase() === preferCountry.toLowerCase(),
			)) ||
		consistent[0];
	const format = chosen.type ?? chosen.format;

	const now = new Date();
	await db
		.update(records)
		.set({
			discogsId: chosen.discogsId,
			discogsUrl: chosen.discogsUrl,
			releaseMissing: false,
			releaseCheckedAt: now,
			amazonResolveStatus: "idle",
			amazonResolveError: null,
			// The exact pressing is authoritative for the album too — adopt its master
			// only when the record had none, keeping health flags fresh.
			...(chosen.masterId && !record.masterId
				? {
						masterId: chosen.masterId,
						masterUrl: chosen.masterUrl,
						masterMissing: false,
						masterCheckedAt: now,
					}
				: {}),
			// Pressing-specific caches from the matched release.
			...(chosen.catno ? { catno: chosen.catno } : {}),
			...(chosen.country ? { country: chosen.country } : {}),
			...(chosen.label ? { label: chosen.label } : {}),
			...(format ? { format } : {}),
			...(chosen.size ? { size: chosen.size } : {}),
			...(chosen.year ? { year: chosen.year } : {}),
			...(chosen.genre ? { genre: chosen.genre } : {}),
			discCount: chosen.discCount,
			updatedAt: now,
		})
		.where(eq(records.id, recordId));
	console.info(
		`[queue] resolve-asin ${asin}: pinned release ${chosen.discogsId} (${
			chosen.country ?? "?"
		}) on record ${recordId}`,
	);
}

async function processMessage(message: Message<AnalyzeMessage>): Promise<void> {
	// Colors-keyed job — handled entirely separately from the records pipeline below.
	if (message.body.mode === "color-texture") {
		const { colorId } = message.body;
		try {
			await generateColorTexture(colorId);
		} catch (err) {
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

	// Palette-only backfill from an existing texture — no Replicate call.
	if (message.body.mode === "color-palette") {
		const { colorId } = message.body;
		try {
			await extractStoredColorPalette(colorId);
		} catch (err) {
			console.error(
				`[queue] color-palette failed for color ${colorId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			Sentry.captureException(err);
		}
		message.ack();
		return;
	}

	// Amazon ASIN → exact pressing (via barcode), pinned in the background. Its own
	// branch (not a record `mode`) so it never touches the capture-pipeline fields.
	if (message.body.mode === "resolve-asin") {
		const { recordId, asin, country } = message.body;
		try {
			await resolveAsinForRecord(recordId, asin, country);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(
				`[queue] resolve-asin failed for record ${recordId} (${asin}): ${reason}`,
			);
			Sentry.captureException(err);
			// resolveAsinForRecord clears "queued" on every path it completes, but an
			// uncaught throw (e.g. identifyFromAsin itself erroring, not just missing a
			// barcode) skips that — without this the row would stay "queued" forever,
			// permanently hidden from re-import with nothing left to ever clear it.
			// Best-effort recovery write: if THIS also fails (a second D1 blip right after
			// the first), the row is left "queued" — an already-known, narrow gap the
			// staleness reap in listInFlight now catches, so log rather than silently
			// swallow instead of leaving zero trace of a double failure.
			await getDb(env.DB)
				.update(records)
				.set({ amazonResolveStatus: "failed", amazonResolveError: reason })
				.where(eq(records.id, recordId))
				.catch((cleanupErr) => {
					console.error(
						`[queue] resolve-asin: failed to flag record ${recordId} as failed`,
						cleanupErr,
					);
					Sentry.captureException(cleanupErr);
				});
		}
		message.ack();
		return;
	}

	// Background matte-quality sweep — not keyed to any record. Runs one bounded batch
	// (see MATTE_AUDIT_BATCH) and, if that batch came back full (more may be due),
	// self-enqueues another before acking — the same "consumer enqueues the next stage"
	// pattern the Apply pipeline uses between "professional" and "professional-matte".
	if (message.body.mode === "audit-mattes") {
		try {
			const { more } = await stepMatteAuditSweep();
			if (more) await enqueueAuditMattes();
			message.ack();
		} catch (err) {
			const willRetry = message.attempts <= MAX_RETRIES;
			console.error(
				`[queue] audit-mattes step failed (attempt ${message.attempts}, willRetry=${willRetry}): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			Sentry.captureException(err);
			if (willRetry) {
				// A transient D1/network blip — same backoff-and-retry the other stages
				// use, rather than abandoning the sweep on the first hiccup.
				message.retry({ delaySeconds: backoffSeconds(message.attempts) });
				return;
			}
			// Retries exhausted — don't leave the sweep stuck "running" forever with no
			// further messages coming; flag it stopped so the queue menu doesn't show a
			// phantom sweep. Best-effort: if this write also fails, log rather than
			// silently swallow — a double failure here is exactly the kind of thing that
			// would otherwise leave a permanently "running" sweep with zero trace of why.
			await getDb(env.DB)
				.update(matteAuditState)
				.set({ running: false, updatedAt: new Date() })
				.where(eq(matteAuditState.id, 1))
				.catch((cleanupErr) => {
					console.error(
						"[queue] audit-mattes: failed to clear running state",
						cleanupErr,
					);
					Sentry.captureException(cleanupErr);
				});
			message.ack();
		}
		return;
	}

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
					professionalStage: "cover",
					// First visible sub-step; the enhance checkpoint follows via the callback.
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

			const stage = await generateProfessionalCover(record, (step) =>
				setJobStep(db, recordId, step),
			);
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
	//   - "professional-matte": try the Magic matte only (`renderAiMatte`, no inline fallback).
	//     On success, commit cover + Magic matte. On failure, log the real error to Sentry and
	//     retry the AI stage until the queue's retries run out — only THEN re-enqueue the
	//     deterministic fallback to a clean isolate (we prefer AI; deterministic is a last
	//     resort, not the response to a transient blip).
	//   - "professional-matte-fallback": render the deterministic matte here and commit it
	//     (or, if it too fails, preserve the existing matte + flag `failed`).
	// The cover key + input snapshot from stage 1 rides on the message in both, so whichever
	// matte wins swaps in with the same cover atomically (no public gap).
	if (mode === "professional-matte" || mode === "professional-matte-fallback") {
		const isFallback = mode === "professional-matte-fallback";
		const {
			coverKey,
			enhanced,
			captureKey,
			bandJson,
			paramsJson,
			aiMatteError,
		} = message.body;
		try {
			const [record] = await db
				.update(records)
				.set({
					professionalJobStatus: "processing",
					professionalStage: "matte",
					// The AI attempt vs the (last-resort) deterministic render read differently
					// in the menu; the finishing checkpoint is stamped just before the commit.
					jobStep: isFallback ? "matte-fallback" : "matte-ai",
					updatedAt: new Date(),
				})
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
				// The Magic matte already failed for good (its retries were exhausted upstream)
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
				await setJobStep(db, recordId, "finishing");
				// A successful deterministic fallback still notes why AI was skipped, so the
				// silent downgrade is visible in the admin UI (not just Sentry).
				await commitProfessionalMatte(record, stage, matte, matteError, {
					aiFallbackReason: aiMatteError ?? null,
				});
				message.ack();
				return;
			}

			// Magic matte only — no inline deterministic fallback (that would stack the two big
			// renders on one isolate). We PREFER the Magic matte, so a failure isn't an
			// immediate downgrade; `nextMatteAction` (pure, tested) decides between commit,
			// another AI attempt, or the last-resort deterministic fallback.
			let aiMatte: MatteKeys | null = null;
			let aiError: unknown = null;
			try {
				aiMatte = await renderAiMatte(stage);
			} catch (err) {
				aiError = err;
			}

			const action = nextMatteAction(
				aiMatte != null,
				message.attempts,
				MAX_RETRIES,
			);
			if (action === "commit") {
				await setJobStep(db, recordId, "finishing");
				await commitProfessionalMatte(record, stage, aiMatte, null);
				message.ack();
				return;
			}

			// AI failed — capture the ACTUAL error (Replicate error, fetch status, OOM, …)
			// so the fallback can't silently mask why AI never ran.
			const detail =
				aiError instanceof Error ? aiError.message : String(aiError);
			console.warn(
				`[queue] Magic matte failed for record ${recordId} (attempt ${message.attempts}, action=${action}): ${detail}`,
			);
			Sentry.captureException(aiError);
			if (action === "retry-ai") {
				// Keep trying AI — don't drop to deterministic yet.
				await markProfessionalFailed(db, recordId, true, detail);
				message.retry({ delaySeconds: backoffSeconds(message.attempts) });
				return;
			}
			// action === "fallback" — AI genuinely exhausted, defer the deterministic
			// render to its own fresh isolate (carrying the AI reason so a successful
			// fallback can still show it in the admin UI).
			await enqueueProfessionalMatteFallback(recordId, stage, detail);
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
