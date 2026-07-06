/**
 * Splitting helpers for bulk work, kept dependency-free so both the server
 * data-access layer and the queue producer can share them — and so the splitting
 * math is unit-testable without a Workers runtime (see batching.test.ts). Two
 * hard platform limits drive everything here:
 *
 *  - D1 rejects any query with more than 100 bound parameters.
 *  - Cloudflare Queues accept at most 100 messages per `sendBatch` call.
 */

/** Message enqueued for the analyze consumer. Re-exported from `#/lib/queue`. */
export interface AnalyzeMessage {
	recordId: number;
	// "analyze" (default) runs the full capture pipeline; "refresh" only re-pulls
	// the Discogs release for an already-identified record.
	mode?: "analyze" | "refresh";
}

/**
 * Chunk size for bulk `inArray(id, ids)` queries. Kept comfortably under D1's
 * 100-bound-parameter ceiling so a companion `.set(...)` (whose columns also
 * bind parameters) can't tip an otherwise-legal batch over the limit.
 */
export const D1_PARAM_CHUNK = 90;

/** Cloudflare Queues accept at most 100 messages per `sendBatch` call. */
export const QUEUE_BATCH_SIZE = 100;

/**
 * Split a list into consecutive chunks of at most `size` items (the final chunk
 * may be shorter). Order and membership are preserved: flattening the result
 * reproduces the input. Throws on a non-positive size rather than looping forever.
 */
export function chunk<T>(items: T[], size: number): T[][] {
	if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/**
 * Build the chunked `sendBatch` payloads for a bulk enqueue: one inner array per
 * queue write, each holding at most {@link QUEUE_BATCH_SIZE} messages in input
 * order. Pure — the caller hands each returned batch to `queue.sendBatch`. An
 * empty id list yields no batches (so no queue write happens at all).
 */
export function toQueueBatches(
	recordIds: number[],
	mode?: AnalyzeMessage["mode"],
): Array<Array<{ body: AnalyzeMessage }>> {
	return chunk(recordIds, QUEUE_BATCH_SIZE).map((slice) =>
		slice.map((recordId) => ({ body: { recordId, mode } })),
	);
}
