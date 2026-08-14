import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "#/db";
import { records } from "#/db/schema";
import { generateMatteFromCapture } from "#/lib/matte";
import { professionalPipeline } from "#/lib/professional";
import { parseReframeParams } from "#/lib/reframe-params";
import { serializeCornerBand } from "#/lib/sleeve-corners";

/**
 * The free first-pass professional photo for a fresh (or replaced) capture:
 * detect the sleeve's corners, warp to a straight square, and cut the
 * deterministic matte from the same band. Ran inline in the capture POST until
 * that OOM'd: the photon pass allocates several 2048² RGBA buffers, and stacked
 * with whatever else the isolate is doing (the analyze consumer chewing through
 * the previous capture, the request's own transform output) it brushed the
 * 128 MB ceiling — reliably so in preview, where the analyze queue is always
 * busy. Now a queue message (`mode: "capture-first-pass"`), so it gets its own
 * isolate — the same split the Apply pipeline already uses for the same reason.
 *
 * Best-effort like the inline version was: failure marks the professional*
 * track `failed` on the row (a manual re-crop retries) and never throws, so the
 * consumer always acks — a deterministic pixel-math failure won't retry-storm.
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

	try {
		const { professionalKey, band } = await professionalPipeline(record);
		// Deterministic matte from the same detected corner band — free, no paid
		// model call; the editor's Apply can upgrade it to the matting model.
		// Best-effort: a matte failure never fails the first pass.
		const matte = await generateMatteFromCapture(
			record.capturePhotoKey,
			band,
			parseReframeParams(record.professionalParamsJson),
			{ useAi: false },
		).catch((err) => {
			console.error("capture-first-pass: matte generation failed", err);
			return null;
		});
		await db
			.update(records)
			.set({
				professionalImageKey: professionalKey,
				// Persist the detected seed so the editor opens pre-cropped; a later
				// Apply overwrites it with the admin's band.
				sleeveCornersJson: serializeCornerBand(band),
				professionalAlphaKey: matte?.shadowKey ?? null,
				professionalAlphaCutoutKey: matte?.cutoutKey ?? null,
				professionalAlphaSource: matte?.source ?? null,
				// Generated, but not shown on the site until an admin approves it.
				professionalStatus: "ready",
				professionalError: null,
				updatedAt: new Date(),
			})
			.where(eq(records.id, recordId));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		await db
			.update(records)
			.set({
				professionalStatus: "failed",
				professionalError: `Could not generate professional photo: ${detail}`,
				updatedAt: new Date(),
			})
			.where(eq(records.id, recordId))
			.catch(() => {});
	}
}
