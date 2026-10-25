import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "#/db";
import { records } from "#/db/schema";
import { professionalPipeline } from "#/lib/professional";
import { serializeCornerBand } from "#/lib/sleeve-corners";

/**
 * The free first-pass professional photo for a fresh (or replaced) capture:
 * detect the sleeve's corners and warp to a straight square. Ran inline in the
 * capture POST until that OOM'd: the photon pass allocates several 2048² RGBA
 * buffers, and stacked with whatever else the isolate is doing (the analyze
 * consumer chewing through the previous capture, the request's own transform
 * output) it brushed the 128 MB ceiling — reliably so in preview, where the
 * analyze queue is always busy. So it runs from the `capture-first-pass` queue
 * message instead.
 *
 * Best-effort like the inline version was, and never throws — the consumer
 * always acks. A failure marks the professional* track `failed` (a manual
 * re-crop retries).
 *
 * Every write is guarded on the capture it was computed from still being on the
 * row — a replace clears the row and re-enqueues, so a still-in-flight (or
 * redelivered) message for the superseded capture must not stomp the fresh
 * one's fields with stale results.
 */
export async function runCaptureFirstPass(recordId: number): Promise<void> {
	const db = getDb(env.DB);
	const [record] = await db
		.select()
		.from(records)
		.where(eq(records.id, recordId))
		.limit(1);
	// Deleted between enqueue and delivery, or a row with nothing to work from.
	if (!record?.capturePhotoKey) return;

	// Guard every write on the capture this run was computed from: a replace
	// swaps `capturePhotoKey` and re-enqueues, so a match on 0 rows means this
	// message is for a superseded capture and its results must be dropped.
	const sameCapture = and(
		eq(records.id, recordId),
		eq(records.capturePhotoKey, record.capturePhotoKey),
	);

	try {
		const { professionalKey, band, detection } =
			await professionalPipeline(record);
		await db
			.update(records)
			.set({
				professionalImageKey: professionalKey,
				// Persist the detected seed so the editor opens pre-cropped; a later
				// Apply overwrites it with the admin's band.
				sleeveCornersJson: serializeCornerBand(band),
				// The seed's confidence/source drive the editor's on-open badge and the
				// review queue. It's an unreviewed auto-seed until the admin saves the band,
				// so reset `cornersReviewed` (a re-capture must re-enter the queue).
				detectionConfidence: detection?.confidence ?? null,
				detectionSource: detection?.source ?? null,
				cornersReviewed: false,
				// Generated, but not shown on the site until an admin approves it.
				professionalStatus: "ready",
				professionalError: null,
				updatedAt: new Date(),
			})
			.where(sameCapture);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		await db
			.update(records)
			.set({
				professionalStatus: "failed",
				professionalError: `Could not generate professional photo: ${detail}`,
				updatedAt: new Date(),
			})
			.where(sameCapture)
			.catch(() => {});
	}
}
