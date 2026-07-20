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
 * Atomicity AND input-consistency are preserved across the split. Atomicity: the cover
 * stage writes nothing to the record's display fields — it hands its result to the matte
 * stage via the queue message, and the matte stage swaps in the new cover *and* matte in
 * one DB write, so an already-live cover only changes at the very end (no public gap).
 * Consistency: the cover stage also carries its exact inputs (capture + band + params)
 * forward on the message ({@link CoverStageResult}); the matte stage renders from THAT
 * snapshot, not a fresh record read, so the cover and matte are always cut from the same
 * capture — the guarantee the old single-invocation had. (Without this, a record edited
 * between stages — e.g. a concurrent Replace capture — could pair a stage-1 cover with a
 * matte cut from a different capture.)
 *
 * Both Replicate steps stay best-effort: an enhance hiccup degrades to a plain reframe,
 * and a matte hiccup falls back (AI → deterministic, and a total matte failure preserves
 * the existing matte and flags the job `failed` rather than binning a good one). Kept out
 * of `records.ts` to avoid an import cycle with the queue (records → queue → this module).
 */

/**
 * The stage-1 result handed to the matte stage over the queue message: the new cover
 * key + whether it was enhanced, AND the exact inputs the cover was built from —
 * serialized so they ride on the message. Carrying the inputs forward (rather than
 * re-reading the record in stage 2) is what keeps the cover and matte mutually
 * consistent: both are rendered from this one snapshot, even if the record changes
 * between stages (e.g. a concurrent Replace capture).
 */
export interface CoverStageResult {
	coverKey: string;
	enhanced: boolean;
	captureKey: string;
	bandJson: string; // serialized (normalised) CornerBand
	paramsJson: string; // serialized ReframeParams
}

/**
 * Stage 1 — the cover. Reframe the square from the record's stored corners + tone, then
 * (best-effort) Real-ESRGAN enhance it. Returns the cover key + the input snapshot it was
 * built from (see {@link CoverStageResult}); writes nothing to the DB (the matte stage
 * commits). The reframe is cheap and the enhance streams through the Images binding (no
 * big in-JS RGBA), so this stage's memory footprint is modest — the heavy work is
 * deferred to {@link commitProfessionalMatte}.
 */
export async function generateProfessionalCover(
	record: Record,
): Promise<CoverStageResult> {
	if (!record.capturePhotoKey) {
		throw new Error("This record has no capture photo to generate from.");
	}
	const captureKey = record.capturePhotoKey;
	const band = parseCornerBand(record.sleeveCornersJson);
	const params = parseReframeParams(record.professionalParamsJson);

	// The square hero (free) — staging for the enhance.
	const { key: baseKey } = await reframeFromCapture(captureKey, band, params);
	// Enhance is best-effort: a Replicate hiccup degrades to the plain reframe.
	const enhancedKey = await upscaleProfessional(baseKey)
		.then((r) => r.key)
		.catch((err) => {
			console.error(`[pro] enhance failed for record ${record.id}`, err);
			return null;
		});
	// When the enhance succeeds, the base reframe was only a staging step — bin it.
	if (enhancedKey) await env.PHOTOS.delete(baseKey).catch(() => {});
	return {
		coverKey: enhancedKey ?? baseKey,
		enhanced: enhancedKey != null,
		// The exact inputs the cover came from — the matte stage renders from and
		// re-persists these same values (not a fresh record read).
		captureKey,
		bandJson: serializeCornerBand(band),
		paramsJson: JSON.stringify(params),
	};
}

/** The two R2 matte keys + which path produced them — what a matte render returns. */
export type MatteKeys = {
	shadowKey: string;
	cutoutKey: string;
	source: "ai" | "deterministic";
};

/**
 * Render ONLY the paid AI matte from a stage-1 {@link CoverStageResult} snapshot, with the
 * in-isolate deterministic fallback disabled (`fallback: false`) — so a failed AI attempt
 * rethrows here instead of stacking the (much larger, ~3000² deskew) deterministic render
 * on the same isolate the AI buffers already loaded. The queue re-enqueues the fallback to
 * a fresh isolate on failure (see {@link renderDeterministicMatte}). Throws on any AI
 * failure; the caller decides what to do.
 */
export function renderAiMatte(stage: CoverStageResult): Promise<MatteKeys> {
	return generateMatteFromCapture(
		stage.captureKey,
		parseCornerBand(stage.bandJson),
		parseReframeParams(stage.paramsJson),
		{ useAi: true, fallback: false },
	);
}

/**
 * Render ONLY the free deterministic matte from the stage-1 snapshot — the fallback the
 * queue runs in its own fresh isolate after {@link renderAiMatte} fails. Kept off the AI
 * isolate on purpose: its deskew buffer (~3000²) alone is a big fraction of the 128 MB
 * budget, so it must not share a heap with the AI attempt's residue.
 */
export function renderDeterministicMatte(
	stage: CoverStageResult,
): Promise<MatteKeys> {
	return generateMatteFromCapture(
		stage.captureKey,
		parseCornerBand(stage.bandJson),
		parseReframeParams(stage.paramsJson),
		{ useAi: false },
	);
}

/**
 * Stage 2 — commit a rendered matte alongside the stage-1 cover in one atomic DB write,
 * promoting the professional photo to live. The `matte` is rendered separately (by the
 * queue, per-isolate: {@link renderAiMatte} then, on failure, {@link renderDeterministicMatte}
 * in a fresh isolate) and passed in — NOT generated here — so the two memory-heavy renders
 * never share this commit's isolate. All display fields (cover + matte) are written from the
 * stage-1 {@link CoverStageResult} snapshot (capture + corners + tone), so the committed
 * cover and matte are always cut from the same inputs even if the record changed between
 * stages. The record is re-read only for the atomic write target + binning the superseded
 * cover/matte from R2. `enhanced` records whether `coverKey` came from the Real-ESRGAN pass.
 *
 * Pass `matte: null` with the `matteError` that killed BOTH the AI and deterministic paths
 * to preserve the existing matte, commit the (fresh) cover anyway, and flag the job
 * `failed` so the editor offers a retry — rather than binning a good matte we already had.
 */
export async function commitProfessionalMatte(
	record: Record,
	stage: CoverStageResult,
	matte: MatteKeys | null,
	matteError: unknown,
): Promise<void> {
	const { coverKey, enhanced, bandJson, paramsJson } = stage;

	// A matte failure must NOT wipe a matte we already had. Reaching here with `matte:
	// null` means *both* the AI and deterministic renders died (each in its own isolate)
	// — almost always a transient R2/Images blip (e.g. "Network connection lost."). Keep
	// the existing matte live, commit the (fresh) cover, and flag the job `failed` with
	// the error so the editor offers a retry — rather than silently degrading to no matte
	// and binning the good one.
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
			// Persist the SAME (normalised) band + params the cover + matte were built
			// from — carried from stage 1 — so the stored inputs match the stored images
			// (and legacy single-quad rows upgrade to the band shape on their next Apply).
			sleeveCornersJson: bandJson,
			professionalImageKey: coverKey,
			professionalParamsJson: paramsJson,
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
