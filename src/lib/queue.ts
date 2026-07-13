import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { and, eq, inArray, ne } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record, records } from "#/db/schema";
import { analyzeCapture, findDuplicateOf } from "#/lib/analyze";
import { type AnalyzeMessage, toQueueBatches } from "#/lib/batching";
import { getReleaseDetail, getReleaseValue } from "#/lib/discogs";
import { professionalPipeline } from "#/lib/professional";

/**
 * Background analysis via a Cloudflare Queue. Capturing a record inserts a
 * `pending` row and enqueues its id here; the consumer (wired in src/server.ts)
 * runs the AI pipeline and moves the row to `review`, or `failed` after the
 * queue's retries are exhausted. The DLQ catches anything that still fails.
 */

export type { AnalyzeMessage } from "#/lib/batching";

/** `max_retries` from wrangler.jsonc — used only to label the row once retries run out. */
const MAX_RETRIES = 3;

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

/** Enqueue a captured record for professional studio-photo generation. */
export async function enqueueProfessional(recordId: number): Promise<void> {
	await analyzeQueue().send({ recordId, mode: "professional" });
}

/** Enqueue many captured records for professional studio-photo generation. */
export function enqueueProfessionalBatch(recordIds: number[]): Promise<void> {
	return enqueueBatch(recordIds, "professional");
}

/**
 * How long a professional job may sit in `pending`/`processing` before a reader
 * treats it as dead. Comfortably above a healthy run — the reframe is just a decode,
 * perspective-warp and Images pass (a few seconds) — so a still-working job is never
 * falsely failed, while a wedged one (e.g. a deploy landing mid-run) is caught promptly.
 */
export const PROFESSIONAL_STALE_MS = 10 * 60 * 1000;

/**
 * Whether a professional-photo row has wedged: it's still `pending`/`processing`
 * but hasn't advanced in {@link PROFESSIONAL_STALE_MS}. Pure (takes `now`) so the
 * threshold can be tested without a clock or the DB. A missing `updatedAt` counts
 * as epoch, i.e. always stale.
 */
export function isProfessionalStale(
	record: Pick<Record, "professionalStatus" | "updatedAt">,
	now: number,
): boolean {
	if (
		record.professionalStatus !== "pending" &&
		record.professionalStatus !== "processing"
	) {
		return false;
	}
	const updatedAt = record.updatedAt?.getTime() ?? 0;
	return now - updatedAt >= PROFESSIONAL_STALE_MS;
}

/**
 * Watchdog for a wedged professional-photo job. The consumer always writes a
 * terminal `ready`/`failed` (even on a caught error), so the only way a row stays
 * `pending`/`processing` is a failure *outside* that try/catch: an isolate evicted
 * or over its wall-clock/subrequest limit, a deploy landing mid-run, or an enqueue
 * that never delivered. Nothing else reconciles those, so the admin page would spin
 * forever. When a reader sees such a stale row (see {@link isProfessionalStale}),
 * flip it to `failed` so the page self-heals to a "Try again" button. Returns the
 * (possibly updated) row; a no-op for anything that isn't actually stale.
 */
export async function failStaleProfessional(record: Record): Promise<Record> {
	if (!isProfessionalStale(record, Date.now())) return record;

	// Compare-and-swap: only reclaim the exact stuck row we read. If the consumer
	// landed a terminal `ready`/`failed` (or a manual regenerate bumped it to a
	// fresh `pending`) in the gap between our read and this write, the status/
	// `updatedAt` guards below won't match — so we leave that newer state alone
	// rather than clobbering a good photo back to `failed`.
	const guards = [
		eq(records.id, record.id),
		inArray(records.professionalStatus, ["pending", "processing"]),
	];
	if (record.updatedAt) guards.push(eq(records.updatedAt, record.updatedAt));

	const db = getDb(env.DB);
	const [row] = await db
		.update(records)
		.set({
			professionalStatus: "failed",
			professionalError:
				"Generation timed out — the job stalled before finishing. Try again.",
			updatedAt: new Date(),
		})
		.where(and(...guards))
		.returning();
	// No match → someone advanced the row first; keep what we read, next poll re-syncs.
	return row ?? record;
}

/**
 * Re-pull an already-identified record from its stored Discogs release id and
 * update the enrichment fields (year, label, genre, format, size, catno,
 * country) plus a fresh value estimate. Only overwrites a field when Discogs
 * returns a value, so it never nulls out good data. Leaves artist/title/status
 * alone — identity was confirmed at publish. Returns the updated row, or null if
 * the record is gone or has no Discogs id. Shared by the sync `refreshRecord`
 * server fn and the bulk queue.
 */
export async function refreshRecordById(id: number): Promise<Record | null> {
	const db = getDb(env.DB);
	const [record] = await db
		.select()
		.from(records)
		.where(eq(records.id, id))
		.limit(1);
	if (!record?.discogsId) return null;

	const detail = await getReleaseDetail(record.discogsId);
	if (!detail) return record;

	// Value is best-effort — a missing/failed price lookup shouldn't block the
	// metadata refresh, so fetch it separately and keep the previous figure on miss.
	const value = await getReleaseValue(record.discogsId).catch(() => null);

	const [row] = await db
		.update(records)
		.set({
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

	// Professional studio photo. Runs the deterministic reframe from the record's stored
	// (or full-frame default) corners — free, no external call. This is the auto-on-capture
	// + bulk path; interactive corner edits go through the reframeRecord server fn inline.
	// Like refresh, it's best-effort and self-contained — it tracks its own `professional*`
	// fields and never touches the record's main `status`, and always acks.
	if (mode === "professional") {
		try {
			const [record] = await db
				.select()
				.from(records)
				.where(eq(records.id, recordId))
				.limit(1);
			// Deleted between enqueue and delivery — nothing to do.
			if (!record) {
				message.ack();
				return;
			}
			if (!record.capturePhotoKey) {
				throw new Error("record has no capture photo to work from");
			}

			await db
				.update(records)
				.set({
					professionalStatus: "processing",
					professionalError: null,
					updatedAt: new Date(),
				})
				.where(eq(records.id, recordId));

			// Deterministic reframe from the stored/default corners (shared with the
			// interactive server fn so both paths behave identically).
			const { professionalKey } = await professionalPipeline(record);

			await db
				.update(records)
				.set({
					professionalImageKey: professionalKey,
					// Generated, but not shown until an admin approves it (review gate).
					professionalStatus: "ready",
					professionalError: null,
					updatedAt: new Date(),
				})
				.where(eq(records.id, recordId));

			// A regenerate supersedes any previous professional image; bin the old
			// object so a redo doesn't orphan it in R2. Best-effort — the row already
			// points at the new key, so a failed cleanup just leaves a stale object.
			const stale = record.professionalImageKey;
			if (stale && stale !== professionalKey) {
				await env.PHOTOS.delete(stale).catch(() => {});
			}
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(
				`[queue] professional photo failed for record ${recordId}: ${detail}`,
			);
			Sentry.captureException(err);
			await db
				.update(records)
				.set({
					professionalStatus: "failed",
					professionalError: detail,
					updatedAt: new Date(),
				})
				.where(eq(records.id, recordId))
				.catch(() => {});
		}
		message.ack();
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

		if (!result.discogsId) {
			// Identified the sleeve but couldn't attach a Discogs release — either a
			// genuine gap in Discogs or a transient failure that outlived the fetch
			// retries. Surface it so "Unmatched" records are observable rather than
			// silently landing in review with no release linked.
			Sentry.captureMessage(
				`[analyze] no Discogs match for record ${recordId} (${result.artist} — ${result.title})`,
				"warning",
			);
		}

		// Flag the record if the collection already holds this release. Compared
		// against every other row (the capture itself is excluded by id), matching
		// on Discogs id first, then on normalized artist + title.
		const others = await db
			.select({
				id: records.id,
				artist: records.artist,
				title: records.title,
				discogsId: records.discogsId,
			})
			.from(records)
			.where(ne(records.id, recordId));
		const duplicateOf = findDuplicateOf(
			{
				artist: result.artist,
				title: result.title,
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
