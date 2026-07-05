import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { eq, ne } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record, records } from "#/db/schema";
import { analyzeCapture, findDuplicateOf } from "#/lib/analyze";
import { getReleaseDetail } from "#/lib/discogs";

/**
 * Background analysis via a Cloudflare Queue. Capturing a record inserts a
 * `pending` row and enqueues its id here; the consumer (wired in src/server.ts)
 * runs the AI pipeline and moves the row to `review`, or `failed` after the
 * queue's retries are exhausted. The DLQ catches anything that still fails.
 */

export interface AnalyzeMessage {
	recordId: number;
	// "analyze" (default) runs the full capture pipeline; "refresh" only re-pulls
	// the Discogs release for an already-identified record (used by "Rescan all").
	mode?: "analyze" | "refresh";
}

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

/** Enqueue a published record to be re-pulled from its stored Discogs release. */
export async function enqueueRefresh(recordId: number): Promise<void> {
	await analyzeQueue().send({ recordId, mode: "refresh" });
}

/**
 * Re-pull an already-identified record from its stored Discogs release id and
 * update the enrichment fields (year, label, genre, format, size, catno,
 * country). Only overwrites a field when Discogs returns a value, so it never
 * nulls out good data. Leaves artist/title/status alone — identity was confirmed
 * at publish. Returns the updated row, or null if the record is gone or has no
 * Discogs id. Shared by the sync `refreshRecord` server fn and the bulk queue.
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
			updatedAt: new Date(),
		})
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
