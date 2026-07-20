import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record, records } from "#/db/schema";
import { generateMatteFromCapture } from "#/lib/matte";
import { reframeFromCapture, upscaleProfessional } from "#/lib/professional";
import { parseReframeParams } from "#/lib/reframe-params";
import { parseCornerBand, serializeCornerBand } from "#/lib/sleeve-corners";

/**
 * The paid "Apply" pipeline, split across two queue messages so each memory-heavy step
 * runs in its own invocation — {@link generateProfessionalCover} (reframe + Real-ESRGAN
 * enhance), then {@link commitProfessionalMatte} (AI matte + the final commit). A single
 * invocation doing all three stacked a reframe buffer, the enhance, and the matte's
 * full-resolution RGBA buffers (~2000² warp + ESRGAN + 2400² matte warp) on one 128 MB
 * isolate — enough to tip a marginal run into an uncatchable OOM that left the record
 * stuck `processing` with no error (the runtime even shed the in-flight Replicate
 * connections as it died — "Network connection lost."). Splitting means the matte, the
 * real hog, starts from a clean heap with none of the reframe/enhance residue.
 *
 * Atomicity is preserved across the split: the cover stage writes nothing to the
 * record's display fields — it hands its new cover key to the matte stage via the queue
 * message, and the matte stage swaps in the new cover *and* matte in one DB write. So an
 * already-live cover only changes at the very end, exactly as before — no public gap
 * during regeneration, even though two isolates are now involved.
 *
 * Both Replicate steps stay best-effort: an enhance hiccup degrades to a plain reframe,
 * and a matte hiccup falls back (AI → deterministic, and a total matte failure preserves
 * the existing matte and flags the job `failed` rather than binning a good one). Kept out
 * of `records.ts` to avoid an import cycle with the queue (records → queue → this module).
 */

/**
 * Stage 1 — the cover. Reframe the square from the record's stored corners + tone, then
 * (best-effort) Real-ESRGAN enhance it. Returns the winning cover key and whether it was
 * enhanced; writes nothing to the DB (the matte stage commits). The reframe is cheap and
 * the enhance streams through the Images binding (no big in-JS RGBA), so this stage's
 * memory footprint is modest — the heavy work is deferred to {@link commitProfessionalMatte}.
 */
export async function generateProfessionalCover(
	record: Record,
): Promise<{ coverKey: string; enhanced: boolean }> {
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
	// Enhance is best-effort: a Replicate hiccup degrades to the plain reframe.
	const enhancedKey = await upscaleProfessional(baseKey)
		.then((r) => r.key)
		.catch((err) => {
			console.error(`[pro] enhance failed for record ${record.id}`, err);
			return null;
		});
	// When the enhance succeeds, the base reframe was only a staging step — bin it.
	if (enhancedKey) await env.PHOTOS.delete(baseKey).catch(() => {});
	return { coverKey: enhancedKey ?? baseKey, enhanced: enhancedKey != null };
}

/**
 * Stage 2 — the AI matte and the final atomic commit. Generates the matte from the
 * record's capture + corners + tone, then swaps in the (stage-1) `coverKey` alongside the
 * new matte keys in a single DB write, promoting the professional photo to live. Bins the
 * superseded cover + matte from R2. `enhanced` records whether `coverKey` came from the
 * Real-ESRGAN pass (persisted as `professionalEnhanced`).
 */
export async function commitProfessionalMatte(
	record: Record,
	coverKey: string,
	enhanced: boolean,
): Promise<void> {
	if (!record.capturePhotoKey) {
		throw new Error("This record has no capture photo to generate from.");
	}
	const band = parseCornerBand(record.sleeveCornersJson);
	const params = parseReframeParams(record.professionalParamsJson);

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
			professionalImageKey: coverKey,
			professionalParamsJson: JSON.stringify(params),
			professionalAlphaKey: shadowKey,
			professionalAlphaCutoutKey: cutoutKey,
			professionalAlphaSource: alphaSource,
			professionalEnhanced: enhanced,
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
	// preserved matte on a matte failure, or the just-committed cover). Best-effort.
	const keptKeys = new Set(
		[coverKey, shadowKey, cutoutKey].filter((k): k is string => k != null),
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
