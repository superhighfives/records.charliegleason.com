import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record, records } from "#/db/schema";
import { withPresizedKeys } from "#/lib/photo-variants";
import { reframeFromCapture } from "#/lib/professional";
import { parseReframeParams } from "#/lib/reframe-params";
import { parseCornerBand, serializeCornerBand } from "#/lib/sleeve-corners";

/**
 * The admin's "Apply": re-warp the square cover from the record's stored corners + tone
 * and promote it live, in one queue message. Free and deterministic — no Replicate call,
 * no second stage. Kept out of `records.ts` to avoid an import cycle with the queue
 * (records → queue → this module).
 *
 * The new cover is written to a fresh key and swapped in with one DB write, so an
 * already-live cover only changes at the very end (no public gap). Returns the
 * superseded cover + its pre-sized copies for the caller to bin — later, not now (see
 * `enqueueDeletePhotos`), so pages still holding the old key don't 404.
 */
export async function applyProfessional(
	record: Record,
): Promise<{ staleKeys: string[] }> {
	if (!record.capturePhotoKey) {
		throw new Error("This record has no capture photo to generate from.");
	}
	const band = parseCornerBand(record.sleeveCornersJson);
	const params = parseReframeParams(record.professionalParamsJson);
	const { key: coverKey } = await reframeFromCapture(
		record.capturePhotoKey,
		band,
		params,
	);

	const db = getDb(env.DB);
	await db
		.update(records)
		.set({
			// Persist the SAME (normalised) band + params the cover was built from, so the
			// stored inputs match the stored image.
			sleeveCornersJson: serializeCornerBand(band),
			professionalImageKey: coverKey,
			professionalParamsJson: JSON.stringify(params),
			professionalStatus: "approved",
			professionalJobStatus: "idle",
			jobStep: null,
			// Generation reached a committed cover — clear the reaper's auto-retry budget.
			professionalRetryCount: 0,
			professionalError: null,
			updatedAt: new Date(),
		})
		.where(eq(records.id, record.id));

	const stale = record.professionalImageKey;
	return {
		staleKeys: stale && stale !== coverKey ? withPresizedKeys(stale) : [],
	};
}
