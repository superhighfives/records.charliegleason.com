/**
 * The matte render, in the container. A near-line-for-line port of `matteAI` /
 * `matteFromBand` in `src/lib/matte.ts` — same steps, same constants (imported from the
 * shared `matte-config`), same pixel helpers (imported from the shared `photo-processing` /
 * `matte-pixels`) — with the three binding-coupled calls (decode / encode / ESRGAN upscale)
 * swapped for the sharp shims in `./image-io`, and the Replicate calls taking a token. R2 +
 * DB stay in the Worker: this takes capture bytes + params in and returns two WebP buffers.
 */

import {
	CLAMP_LOWCONF_INSET,
	EDGE_OUTER_PROXIMITY_MAX,
	FEATHER,
	MATTE_ESRGAN_MAX,
	MATTE_MODEL_MAX_SIZE,
	MATTE_MODEL_VERSION,
	MODEL_PAD,
	MODEL_SIZE,
	matteOptions,
	VETO_DEPTH,
	VETO_FG_INSET,
	VETO_RING,
} from "#/lib/matte-config";
import {
	grayToRgba,
	maskFromModelOutput,
	resizeMask,
} from "#/lib/matte-pixels";
import {
	applyMask,
	buildTrimapFromBand,
	clampEdgeOffsets,
	deskewBandPadded,
	despeckleMask,
	EDGE_CONFIDENCE_MIN,
	edgeDistances,
	featherMask,
	keepLargestComponent,
	type MatteResult,
	matteFromBand,
	midQuad,
	offsetQuad,
	type PixelBand,
	type RgbaImage,
	rasterizePolygon,
	refineQuadEdgesDetailed,
	toPixelCorners,
	vetoBackgroundAlpha,
	warpMatteToSquare,
} from "#/lib/photo-processing";
import type { ReframeParams } from "#/lib/reframe-params";
import type { CornerBand } from "#/lib/sleeve-corners";

import { decodeRgba, encodePng, encodeWebp, upscaleImage } from "./image-io.ts";
import { firstOutputUrl, runVersion } from "./replicate.ts";

/** The paid matte — see `src/lib/matte.ts#matteAI` for the full prose behind each step. */
async function matteAI(
	capture: RgbaImage,
	band: CornerBand,
	params: ReframeParams,
	token: string,
): Promise<MatteResult> {
	if (!MATTE_MODEL_VERSION) throw new Error("matting model not configured");
	const pxBand: PixelBand = {
		inner: toPixelCorners(band.inner, capture.width, capture.height),
		outer: toPixelCorners(band.outer, capture.width, capture.height),
	};
	const { content, inner, outer } = deskewBandPadded(
		capture,
		pxBand,
		MODEL_SIZE,
		MODEL_PAD,
	);
	const mid = midQuad(inner, outer);
	const toOuter = edgeDistances(mid, outer);
	const toInner = edgeDistances(mid, inner);
	const { corners: refined, confidence } = refineQuadEdgesDetailed(
		content,
		mid,
		{
			outward: toOuter,
			inward: toInner,
			minConfidence: EDGE_CONFIDENCE_MIN,
		},
	);
	const trimap = buildTrimapFromBand(
		inner,
		outer,
		content.width,
		content.height,
	);

	const imageUri = `data:image/png;base64,${(await encodePng(content)).toString("base64")}`;
	const trimapUri = `data:image/png;base64,${(
		await encodePng(grayToRgba(trimap, content.width, content.height))
	).toString("base64")}`;
	const prediction = await runVersion(token, MATTE_MODEL_VERSION, {
		image: imageUri,
		trimap: trimapUri,
		max_size: MATTE_MODEL_MAX_SIZE,
	});
	const url = firstOutputUrl(prediction.output);
	if (!url) throw new Error("matting model returned no image");

	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetching the matte failed (${res.status})`);
	const model = await decodeRgba(new Uint8Array(await res.arrayBuffer()));

	const clampQuad = offsetQuad(
		mid,
		clampEdgeOffsets(toOuter, edgeDistances(mid, refined), confidence, {
			minConfidence: EDGE_CONFIDENCE_MIN,
			outerProximityMax: EDGE_OUTER_PROXIMITY_MAX,
			lowConfInset: CLAMP_LOWCONF_INSET,
		}),
	);
	const clamp = rasterizePolygon(clampQuad, content.width, content.height);
	const raw = maskFromModelOutput(model, content.width, content.height);
	// The model output is fully consumed into `raw` — release its RGBA buffer.
	model.data = new Uint8ClampedArray(0);
	for (let i = 0; i < raw.length; i++) if (!clamp[i]) raw[i] = 0;
	vetoBackgroundAlpha(content, raw, refined, inner, {
		depth: VETO_DEPTH,
		ring: VETO_RING,
		bgQuad: outer,
		fgInset: VETO_FG_INSET,
	});
	const feathered = featherMask(
		keepLargestComponent(
			despeckleMask(raw, content.width, content.height),
			content.width,
			content.height,
		),
		content.width,
		content.height,
		FEATHER,
	);

	const hi = await upscaleImage(content, token, { maxSize: MATTE_ESRGAN_MAX });
	const cw = content.width;
	const ch = content.height;
	content.data = new Uint8ClampedArray(0);
	const scale = hi.width / cw;
	applyMask(hi, resizeMask(feathered, cw, ch, hi.width, hi.height));
	const quadHi = refined.map(
		([x, y]) => [x * scale, y * scale] as [number, number],
	) as typeof refined;
	return warpMatteToSquare(hi, quadHi, matteOptions(params));
}

export type MatteMode = "ai" | "deterministic";

export interface RenderMatteInput {
	/** Encoded capture bytes (jpeg/webp/png). */
	capture: Uint8Array;
	band: CornerBand;
	params: ReframeParams;
	mode: MatteMode;
	/** Replicate token (only needed for `mode: "ai"`). */
	replicateToken?: string;
}

export interface RenderMatteOutput {
	source: "ai" | "deterministic";
	shadow: Buffer;
	cutout: Buffer;
}

/**
 * Render one matte and return both WebP variants (shadow + cutout) as buffers. `mode: "ai"`
 * runs the paid path and throws on failure (the Worker's queue decides retry vs. the
 * deterministic fallback, exactly as it does today with `renderAiMatte` / `fallback:false`);
 * `mode: "deterministic"` runs the free silhouette.
 */
export async function renderMatte(
	input: RenderMatteInput,
): Promise<RenderMatteOutput> {
	const capture = await decodeRgba(input.capture);
	let result: MatteResult;
	let source: "ai" | "deterministic";
	if (input.mode === "ai") {
		if (!input.replicateToken)
			throw new Error("replicateToken required for AI matte");
		result = await matteAI(
			capture,
			input.band,
			input.params,
			input.replicateToken,
		);
		source = "ai";
	} else {
		const pxBand: PixelBand = {
			inner: toPixelCorners(input.band.inner, capture.width, capture.height),
			outer: toPixelCorners(input.band.outer, capture.width, capture.height),
		};
		result = matteFromBand(capture, pxBand, matteOptions(input.params));
		source = "deterministic";
	}
	const [shadow, cutout] = await Promise.all([
		encodeWebp(result.shadow),
		encodeWebp(result.cutout),
	]);
	return { source, shadow, cutout };
}
