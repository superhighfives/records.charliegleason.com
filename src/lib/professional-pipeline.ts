import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record, records } from "#/db/schema";
import { generateMatteFromCapture } from "#/lib/matte";
import { reframeFromCapture, upscaleProfessional } from "#/lib/professional";
import { parseReframeParams } from "#/lib/reframe-params";
import { parseCornerBand, serializeCornerBand } from "#/lib/sleeve-corners";

/**
 * The paid "Apply" pipeline, run in the queue consumer ({@link handleAnalyzeBatch}) so a
 * ~minute of GPU work doesn't block the request. From the record's stored corners + tone
 * (persisted by `reframeRecord` at enqueue time): reframe the square, then — sequentially —
 * Real-ESRGAN enhance it and generate the AI matte. On success it atomically swaps in the
 * new keys and sets `professionalStatus: "approved"` (so an already-live cover only changes
 * at the very end — no public gap during regeneration).
 *
 * The two steps run one after another (not `Promise.all`) on purpose: the matte path builds
 * a stack of full-resolution RGBA buffers (~2800² enhance + 2400² warp) that alone brushes
 * the Worker's 128 MB isolate ceiling, and it fires its own Real-ESRGAN + ViTMatte calls.
 * Running the enhance concurrently piled another paid job's buffers and a third in-flight
 * Replicate prediction on top — enough to tip a marginal run into an uncatchable OOM that
 * left the record stuck `processing` with no error. Serial trades a little wall-clock (it's
 * a background job) for a lower memory peak and at most one Replicate call in flight.
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
	const band = parseCornerBand(record.sleeveCornersJson);
	const params = parseReframeParams(record.professionalParamsJson);

	// The square hero (free) — staging for the enhance.
	const { key: baseKey } = await reframeFromCapture(
		record.capturePhotoKey,
		band,
		params,
	);
	// Enhance first, then matte — never both at once (see the note above). Each stays
	// best-effort: a Replicate hiccup degrades to a plain reframe / preserved matte.
	const enhancedKey = await upscaleProfessional(baseKey)
		.then((r) => r.key)
		.catch((err) => {
			console.error(`[pro] enhance failed for record ${record.id}`, err);
			return null;
		});
	let matteError: unknown = null;
	const matte = await generateMatteFromCapture(
		record.capturePhotoKey,
		band,
		params,
		{ useAi: true },
	).catch((err) => {
		console.error(`[pro] matte failed for record ${record.id}`, err);
		matteError = err;
		return null;
	});
	// When the enhance succeeds, the base reframe was only a staging step — bin it.
	const professionalImageKey = enhancedKey ?? baseKey;
	if (enhancedKey) await env.PHOTOS.delete(baseKey).catch(() => {});

	// A matte failure must NOT wipe a matte we already had. `generateMatte` already
	// falls back from the AI path to the deterministic one internally, so reaching
	// here means *both* died — almost always a transient R2/Images blip (e.g.
	// "Network connection lost."). Keep the existing matte live, commit the (fresh)
	// cover, and flag the job `failed` with the error so the editor offers a retry —
	// rather than silently degrading to no matte and binning the good one.
	const matteFailed = matteError != null;
	const shadowKey = matteFailed
		? record.professionalAlphaKey
		: (matte?.shadowKey ?? null);
	const cutoutKey = matteFailed
		? record.professionalAlphaCutoutKey
		: (matte?.cutoutKey ?? null);
	const alphaSource = matteFailed
		? record.professionalAlphaSource
		: (matte?.source ?? null);

	const db = getDb(env.DB);
	await db
		.update(records)
		.set({
			// Re-persist the band so a normalised form is stored even on a first crop
			// (and legacy single-quad rows upgrade to the band shape on their next Apply).
			sleeveCornersJson: serializeCornerBand(band),
			professionalImageKey,
			professionalParamsJson: JSON.stringify(params),
			professionalAlphaKey: shadowKey,
			professionalAlphaCutoutKey: cutoutKey,
			professionalAlphaSource: alphaSource,
			professionalEnhanced: enhancedKey != null,
			// Apply promotes the (new) cover to live regardless — the matte is best-effort.
			professionalStatus: "approved",
			professionalJobStatus: matteFailed ? "failed" : "idle",
			professionalError: matteFailed
				? `Matte generation failed: ${matteError instanceof Error ? matteError.message : String(matteError)}`
				: null,
			updatedAt: new Date(),
		})
		.where(eq(records.id, record.id));

	// Bin the superseded professional image + matte so re-applies don't accumulate
	// orphaned R2 objects — but never delete a key we're still pointing at (the
	// preserved matte on a matte failure). Best-effort: the row already points at
	// the committed keys.
	const keptKeys = new Set(
		[professionalImageKey, shadowKey, cutoutKey].filter(
			(k): k is string => k != null,
		),
	);
	for (const staleKey of [
		record.professionalImageKey,
		record.professionalAlphaKey,
		record.professionalAlphaCutoutKey,
	]) {
		if (staleKey && !keptKeys.has(staleKey)) {
			await env.PHOTOS.delete(staleKey).catch(() => {});
		}
	}
}
