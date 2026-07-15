import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record, records } from "#/db/schema";
import { generateMatteFromCapture } from "#/lib/matte";
import { reframeFromCapture, upscaleProfessional } from "#/lib/professional";
import { parseReframeParams } from "#/lib/reframe-params";
import { parseCorners, serializeCorners } from "#/lib/sleeve-corners";

/**
 * The paid "Apply" pipeline, run in the queue consumer ({@link handleAnalyzeBatch}) so a
 * ~minute of GPU work doesn't block the request. From the record's stored corners + tone
 * (persisted by `reframeRecord` at enqueue time): reframe the square, then — in parallel,
 * both paid + independent — Real-ESRGAN enhance it and generate the AI matte. On success
 * it atomically swaps in the new keys and sets `professionalStatus: "approved"` (so an
 * already-live cover only changes at the very end — no public gap during regeneration).
 *
 * Throws only if the record has no capture or the (free) reframe itself fails; the enhance
 * and matte are best-effort, so a Replicate hiccup degrades to a plain reframe / no matte
 * rather than failing the whole job. Kept out of `records.ts` to avoid an import cycle with
 * the queue (records → queue → this module).
 */
export async function generateProfessionalPhoto(record: Record): Promise<void> {
	if (!record.capturePhotoKey) {
		throw new Error("This record has no capture photo to generate from.");
	}
	const corners = parseCorners(record.sleeveCornersJson);
	const params = parseReframeParams(record.professionalParamsJson);

	// The square hero (free) — staging for the enhance.
	const { key: baseKey } = await reframeFromCapture(
		record.capturePhotoKey,
		corners,
		params,
	);
	const [enhancedKey, matte] = await Promise.all([
		upscaleProfessional(baseKey)
			.then((r) => r.key)
			.catch((err) => {
				console.error(`[pro] enhance failed for record ${record.id}`, err);
				return null;
			}),
		generateMatteFromCapture(record.capturePhotoKey, corners, params, {
			useAi: true,
		}).catch((err) => {
			console.error(`[pro] matte failed for record ${record.id}`, err);
			return null;
		}),
	]);
	// When the enhance succeeds, the base reframe was only a staging step — bin it.
	const professionalImageKey = enhancedKey ?? baseKey;
	if (enhancedKey) await env.PHOTOS.delete(baseKey).catch(() => {});

	const db = getDb(env.DB);
	await db
		.update(records)
		.set({
			// Re-persist corners so a normalised form is stored even on a first crop.
			sleeveCornersJson: serializeCorners(corners),
			professionalImageKey,
			professionalParamsJson: JSON.stringify(params),
			professionalAlphaKey: matte?.shadowKey ?? null,
			professionalAlphaCutoutKey: matte?.cutoutKey ?? null,
			professionalAlphaSource: matte?.source ?? null,
			professionalEnhanced: enhancedKey != null,
			// Apply promotes the result to the live cover, and the job is done.
			professionalStatus: "approved",
			professionalJobStatus: "idle",
			professionalError: null,
			updatedAt: new Date(),
		})
		.where(eq(records.id, record.id));

	// Bin the superseded professional image + matte so re-applies don't accumulate
	// orphaned R2 objects. Best-effort — the row already points at the new keys.
	for (const staleKey of [
		record.professionalImageKey,
		record.professionalAlphaKey,
		record.professionalAlphaCutoutKey,
	]) {
		if (
			staleKey &&
			staleKey !== professionalImageKey &&
			staleKey !== matte?.shadowKey &&
			staleKey !== matte?.cutoutKey
		) {
			await env.PHOTOS.delete(staleKey).catch(() => {});
		}
	}
}
