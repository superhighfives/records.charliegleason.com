/**
 * Pure queue helpers kept dependency-free so both the server data-access layer and the
 * queue producer/consumer can share them — and so the logic is unit-testable without a
 * Workers runtime (see batching.test.ts). Covers the bulk-splitting math (bounded by two
 * hard platform limits) and the Apply pipeline's matte state machine:
 *
 *  - D1 rejects any query with more than 100 bound parameters.
 *  - Cloudflare Queues accept at most 100 messages per `sendBatch` call.
 */

/** A `records`-keyed message for the analyze consumer. See {@link AnalyzeMessage}. */
export interface AnalyzeRecordMessage {
	recordId: number;
	// "analyze" (default) runs the full capture pipeline; "refresh" only re-pulls the
	// Discogs release for an already-identified record. The paid Apply pipeline is
	// split across messages so each memory-heavy step gets its own fresh isolate (a
	// single invocation running reframe+enhance+matte brushed the 128 MB ceiling and
	// OOM'd): "professional" does the reframe + Real-ESRGAN enhance (the cover), then
	// enqueues "professional-matte" for the Magic matte + the final atomic commit. If that
	// Magic matte fails, its (larger) deterministic fallback is deferred to yet another
	// isolate — "professional-matte-fallback" — rather than run inline, since stacking
	// the failed AI attempt's buffers with the ~3000² deterministic deskew on one isolate
	// is itself what OOM'd.
	// "capture-first-pass" / "capture-first-pass-matte" are the free on-capture
	// professional seed (detect + warp, then the deterministic matte) — split out of
	// the capture POST after the inline pass OOM'd the request isolate, and split
	// from each other for the same reason the Apply stages are: each is a
	// near-ceiling render on its own.
	mode?:
		| "analyze"
		| "refresh"
		| "capture-first-pass"
		| "capture-first-pass-matte"
		| "professional"
		| "professional-matte"
		| "professional-matte-fallback";
	// Only set on "professional-matte": the stage-1 result — the cover key + the exact
	// (serialized) capture/band/params the cover was built from. Carried forward so the
	// matte stage (a) renders the matte from and re-persists the SAME inputs, keeping
	// cover and matte mutually consistent even if the record changed after stage 1, and
	// (b) swaps the new cover + matte in together in one atomic DB write (no public gap).
	coverKey?: string;
	enhanced?: boolean;
	captureKey?: string;
	bandJson?: string;
	paramsJson?: string;
	// Only set on "professional-matte-fallback": the Magic matte's actual failure reason
	// (why we're running the deterministic fallback at all). Carried so a *successful*
	// fallback can still record it in the admin UI — otherwise the AI failure is invisible
	// there, only in Sentry. Not shown publicly (`professionalError` is admin-only).
	aiMatteError?: string;
}

/**
 * A `colors`-keyed message — generates (or regenerates) a color's reference vinyl
 * texture via Replicate. Its own variant (rather than an optional field bolted onto
 * {@link AnalyzeRecordMessage}) so `recordId` stays required/non-null everywhere it's
 * actually a record job.
 */
export interface ColorTextureMessage {
	mode: "color-texture";
	colorId: number;
}

/**
 * A `colors`-keyed message that re-extracts a color's title-gradient palette from
 * its *existing* stored texture — no Replicate call. Backfills palettes onto
 * colors whose texture predates the palette column (see `backfillColorPalettes`).
 */
export interface ColorPaletteMessage {
	mode: "color-palette";
	colorId: number;
}

/**
 * A `records`-keyed message that resolves an Amazon ASIN to its exact Discogs
 * *pressing* (via the barcode a web-search reads off the product page) and pins it
 * on the record. Its own variant — like the color jobs — so it never touches the
 * capture-pipeline fields. `country` is the marketplace-implied pressing country
 * (Amazon.co.uk → "UK"), a tiebreaker among barcode hits. Enqueued in bulk by the
 * Amazon importer so the slow per-ASIN web-search runs in the background instead of
 * blocking the modal.
 */
export interface ResolveAsinMessage {
	mode: "resolve-asin";
	recordId: number;
	asin: string;
	country: string | null;
}

/**
 * Not keyed to any `records`/`colors` row — sweeps one stalest-first batch of stored
 * mattes (see `runMatteAudit` in matte-audit.ts) and self-enqueues another of these
 * until a pass comes back short of a full batch. Global progress lives in the
 * `matteAuditState` singleton row, not on the message itself.
 */
export interface AuditMattesMessage {
	mode: "audit-mattes";
}

/** Message enqueued for the analyze consumer. Re-exported from `#/lib/queue`. */
export type AnalyzeMessage =
	| AnalyzeRecordMessage
	| ColorTextureMessage
	| ColorPaletteMessage
	| ResolveAsinMessage
	| AuditMattesMessage;

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
	mode?: AnalyzeRecordMessage["mode"],
): Array<Array<{ body: AnalyzeRecordMessage }>> {
	return chunk(recordIds, QUEUE_BATCH_SIZE).map((slice) =>
		slice.map((recordId) => ({ body: { recordId, mode } })),
	);
}

/** What the `professional-matte` consumer should do after a Magic-matte attempt. */
export type MatteAction = "commit" | "retry-ai" | "fallback";

/**
 * Decide the next step of the Magic-matte stage (`professional-matte`) — the "prefer AI"
 * state machine, pulled out pure so it's testable without the Queue/DB plumbing. A
 * successful render commits; a failure retries the AI stage while the queue's redelivery
 * budget lasts (so a transient Replicate/network blip gets another AI attempt rather than
 * an immediate downgrade), and only falls back to the deterministic render once AI is
 * genuinely exhausted. `attempts` is the current delivery's `message.attempts`; the
 * comparison mirrors the queue's own `willRetry` (attempts ≤ `maxRetries` ⇒ retry).
 */
export function nextMatteAction(
	aiSucceeded: boolean,
	attempts: number,
	maxRetries: number,
): MatteAction {
	if (aiSucceeded) return "commit";
	return attempts <= maxRetries ? "retry-ai" : "fallback";
}

/**
 * A background job untouched for longer than this is treated as dead. A queue
 * consumer that's killed mid-run (OOM, wall-clock eviction) never reaches its
 * catch block, so the row keeps its `processing`/`queued` status with no error
 * and sits "in flight" forever. Jobs finish in ~a minute (Replicate calls cap at
 * 120s each), so 5 minutes of no update is safely past the worst legitimate case.
 */
export const STALE_JOB_MS = 5 * 60 * 1000;

/**
 * How many times the reaper re-enqueues a FRESH job before giving up and flagging a dead
 * job terminally failed. Targets uncatchable interruptions (OOM / eviction / mid-deploy
 * termination) the queue's own per-message retries can't recover — a clean re-run usually
 * clears a transient one. Counted per-pipeline on the row (`analyzeRetryCount` /
 * `professionalRetryCount`); reset on success and manual re-triggers.
 */
export const MAX_AUTO_RETRIES = 3;

/**
 * Staleness threshold for a job that's already been reaped `retryCount` times: 5m,
 * then 10m, then 20m. A first interruption is usually transient and worth a prompt
 * re-run, but a job the reaper has ALREADY re-enqueued twice is likely dying to a
 * shared cause (a container roll, a crash-looping instance) — doubling the window
 * each time keeps a wedged batch from hammering the container in lockstep every
 * 5 minutes while it recovers, and spreads the retries across its recovery instead.
 */
export function staleThresholdMs(retryCount: number): number {
	return STALE_JOB_MS * 2 ** Math.min(retryCount, MAX_AUTO_RETRIES - 1);
}
