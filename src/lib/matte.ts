import { env } from "cloudflare:workers";

import { bytesToBase64 } from "#/lib/image-data";
import {
	applyMask,
	buildTrimap,
	deskewContentPadded,
	featherMask,
	keepLargestComponent,
	type MatteOptions,
	type MatteResult,
	matteFromCorners,
	type RgbaImage,
	refineQuadEdges,
	type ShadowOptions,
	warpMatteToSquare,
} from "#/lib/photo-processing";
import {
	blobStream,
	decodeRgba,
	encodePng,
	loadCapture,
	toPixelCorners,
} from "#/lib/professional";
import { matteToneFromParams, type ReframeParams } from "#/lib/reframe-params";
import { firstOutputUrl, runVersion } from "#/lib/replicate";
import type { NormalizedCorners } from "#/lib/sleeve-corners";

/**
 * The second render: a transparent, true-edged sleeve floating on breathing room with
 * a soft contact shadow — the sleeve as an *object in space*, next to the square hero.
 *
 * Both paths perspective-warp the cut sleeve onto an upright rectangle that fills the
 * frame ({@link warpMatteToSquare}) — a clean, front-on floating card with a tight
 * contact shadow, rather than the tilted capture. Two ways to cut it out:
 *   - the FREE, deterministic {@link matteFromCorners} (edge-snap silhouette) — also
 *     the automatic fallback when the paid path is unavailable;
 *   - the PAID {@link matteAI}: deskew the sleeve upright with a wood margin, derive a
 *     *trimap* from the picked corners (cover interior = definite foreground, wood beyond
 *     the edge = definite background, a thin band around the edge = unknown), and run
 *     image + trimap through a pinned ViTMatte deployment. The trimap is the whole point:
 *     the model can only decide the unknown band, so it physically can't cut into the
 *     artwork's depicted subject or keep a neighbouring record — the exact failures a
 *     free-running segmenter hits. Its alpha is composited over our *own* capture pixels
 *     (model-quality edge, real pixels).
 *
 * Each run stores TWO webp-with-alpha objects — a shadow variant (primary, for the
 * floating look) and a pure cutout (for compositing onto any background) — under
 * `alpha/`, served by the existing `/api/photos/$` passthrough. Server-only.
 */

// Same master resolution as the square hero. The sleeve is perspective-warped to fill
// most of the frame, with a small transparent margin left for the contact shadow.
const CANVAS_SIZE = 2000;
const MARGIN = 0.05;
const CONTENT_SIZE = Math.round(CANVAS_SIZE * (1 - 2 * MARGIN));
// Feather (applied at content scale) and a tight down-right contact shadow (canvas
// scale) — close and fairly crisp, so the sleeve reads as a card resting on a surface
// rather than floating high above it.
const FEATHER = 4;
const SHADOW: ShadowOptions = {
	blur: Math.round(CANVAS_SIZE * 0.012),
	offsetX: Math.round(CANVAS_SIZE * 0.003),
	offsetY: Math.round(CANVAS_SIZE * 0.007),
	opacity: 0.3,
};

// The deskewed square (sleeve + a margin of surrounding capture) we send the matting
// model. The wood padding lets us bracket the true sleeve edge in the trimap's unknown
// band, since the admin picks corners *inside* the cover. Sized large so the sleeve
// (~60% of it) keeps plenty of real pixels after we crop + rescale to the content size.
const MODEL_SIZE = 2048;
const MODEL_PAD = 0.2;

// The picked corners sit *inside* the cover, so first snap the quad out to the true
// sleeve edge (max-gradient search up to this far outward), then wrap a tight, symmetric
// unknown band around that refined edge. A narrow band centred on the real boundary is
// what keeps the model from keeping wood — it only decides a thin strip at the edge,
// rather than a wide inside-cover-to-deep-wood zone.
const TRIMAP_REFINE_SEARCH = Math.round(MODEL_SIZE * 0.08);
const TRIMAP_BAND = Math.round(MODEL_SIZE * 0.025);

// The pinned matting model version (Replicate): our own ViTMatte cog (see
// `cog/vitmatte-trimap/`), which takes `image` + `trimap` and returns a grayscale alpha
// (read via `maskFromModelOutput`'s luminance path). Pinned to a known version so the
// input schema can't shift under us. If it's ever unset/down, `matteAI` throws and
// callers fall back to the deterministic silhouette, so the AI checkbox degrades
// gracefully. Update this after re-pushing the cog (`superhighfives/vitmatte-trimap`).
const MATTE_MODEL_VERSION =
	"db47c8e79ec5cc6a56feb4984258fc46fb22ec4da0c2b0a58692455c414212e0";

/** Build the shared matte options from the record's reframe knobs (softened grade). */
function matteOptions(params: ReframeParams): MatteOptions {
	const { tone, polish } = matteToneFromParams(params);
	return {
		canvasSize: CANVAS_SIZE,
		contentSize: CONTENT_SIZE,
		feather: FEATHER,
		tone,
		polish,
		shadow: SHADOW,
	};
}

/**
 * Canonicalise an {@link RgbaImage} to a webp-with-alpha via Photon + the Images
 * binding — a no-op scale-down (already `CANVAS_SIZE`) drives the pipeline without a
 * sharpen pass (which would harden the soft feather/shadow). Alpha is preserved.
 */
async function encodeWebp(image: RgbaImage): Promise<ArrayBuffer> {
	const png = encodePng(image);
	const out = await env.IMAGES.input(blobStream(png))
		.transform({ width: CANVAS_SIZE, height: CANVAS_SIZE, fit: "scale-down" })
		.output({ format: "image/webp", quality: 92 });
	return out.response().arrayBuffer();
}

/** Store both matte variants under a shared `alpha/{uuid}` stem. */
async function storeMatte(
	result: MatteResult,
): Promise<{ shadowKey: string; cutoutKey: string }> {
	const uuid = crypto.randomUUID();
	const shadowKey = `alpha/${uuid}.webp`;
	const cutoutKey = `alpha/${uuid}-cutout.webp`;
	const [shadowBuf, cutoutBuf] = await Promise.all([
		encodeWebp(result.shadow),
		encodeWebp(result.cutout),
	]);
	await Promise.all([
		env.PHOTOS.put(shadowKey, shadowBuf, {
			httpMetadata: { contentType: "image/webp" },
		}),
		env.PHOTOS.put(cutoutKey, cutoutBuf, {
			httpMetadata: { contentType: "image/webp" },
		}),
	]);
	return { shadowKey, cutoutKey };
}

/**
 * Turn a matting model's output into a content-sized alpha mask. The model returns
 * the subject on transparency (RGBA) or a grey mask; we nearest-resample it to the
 * `w`×`h` content and take the alpha channel — or, if the output is fully opaque (a
 * mask-style result with no real alpha), its luminance instead.
 */
function maskFromModelOutput(
	model: RgbaImage,
	w: number,
	h: number,
): Uint8ClampedArray {
	// Does the model output carry a real alpha channel, or is it fully opaque?
	let hasAlpha = false;
	for (let p = 0; p < model.width * model.height; p++) {
		if (model.data[p * 4 + 3] < 250) {
			hasAlpha = true;
			break;
		}
	}
	const mask = new Uint8ClampedArray(w * h);
	for (let y = 0; y < h; y++) {
		const my = Math.min(model.height - 1, Math.round((y / h) * model.height));
		for (let x = 0; x < w; x++) {
			const mx = Math.min(model.width - 1, Math.round((x / w) * model.width));
			const i = (my * model.width + mx) * 4;
			mask[y * w + x] = hasAlpha
				? model.data[i + 3]
				: 0.2126 * model.data[i] +
					0.7152 * model.data[i + 1] +
					0.0722 * model.data[i + 2];
		}
	}
	return mask;
}

/** Wrap a single-channel mask as an opaque RGBA image (r=g=b=value) for PNG encoding. */
function grayToRgba(mask: Uint8ClampedArray, w: number, h: number): RgbaImage {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const v = mask[i];
		data[i * 4] = v;
		data[i * 4 + 1] = v;
		data[i * 4 + 2] = v;
		data[i * 4 + 3] = 255;
	}
	return { data, width: w, height: h };
}

/**
 * The paid matte: deskew the sleeve upright with a wood margin, build a trimap from the
 * picked corners, run image + trimap through the pinned ViTMatte deployment, and
 * composite the returned alpha over our own deskewed capture pixels. Throws if the model
 * isn't configured or errors — the caller falls back to the deterministic path.
 */
async function matteAI(
	capture: RgbaImage,
	corners: NormalizedCorners,
	params: ReframeParams,
): Promise<MatteResult> {
	if (!MATTE_MODEL_VERSION) throw new Error("matting model not configured");
	const px = toPixelCorners(corners, capture.width, capture.height);
	// Deskew upright with a wood margin around the sleeve; `inset` are the picked corners
	// mapped into the deskewed frame — inside the cover, since that's how they're picked.
	const { content, corners: inset } = deskewContentPadded(
		capture,
		px,
		MODEL_SIZE,
		MODEL_PAD,
	);
	// Snap the quad out to the true sleeve edge, then build a tight trimap around it:
	// cover interior locked foreground, wood beyond locked background, only a thin band
	// at the refined edge left unknown for the model to resolve.
	const refined = refineQuadEdges(content, inset, {
		search: TRIMAP_REFINE_SEARCH,
	});
	const trimap = buildTrimap(refined, content.width, content.height, {
		erode: TRIMAP_BAND,
		dilate: TRIMAP_BAND,
	});

	const imageUri = `data:image/png;base64,${bytesToBase64(encodePng(content))}`;
	const trimapUri = `data:image/png;base64,${bytesToBase64(
		encodePng(grayToRgba(trimap, content.width, content.height)),
	)}`;
	const prediction = await runVersion(MATTE_MODEL_VERSION, {
		image: imageUri,
		trimap: trimapUri,
	});
	const url = firstOutputUrl(prediction.output);
	if (!url) throw new Error("matting model returned no image");

	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetching the matte failed (${res.status})`);
	const model = decodeRgba(new Uint8Array(await res.arrayBuffer()));

	// Composite the model's alpha over our own real capture pixels, then crop back to the
	// sleeve + frame it — model-quality edge, real pixels. Keep only the largest blob
	// first, so a stray speck doesn't inflate the crop box and push the cover off-centre.
	const alpha = keepLargestComponent(
		maskFromModelOutput(model, content.width, content.height),
		content.width,
		content.height,
	);
	const feathered = featherMask(alpha, content.width, content.height, 3);
	const cutout: RgbaImage = {
		data: content.data.slice(),
		width: content.width,
		height: content.height,
	};
	applyMask(cutout, feathered);
	// Perspective-warp the model's cutout onto an upright rectangle (using the same
	// refined quad the trimap came from) so it fills the square as a clean front-on
	// sleeve, then tone + tight shadow.
	return warpMatteToSquare(cutout, refined, matteOptions(params));
}

/**
 * Generate + store both matte variants for a decoded capture. With `useAi`, tries the
 * paid matting model and falls back to the free deterministic silhouette on any
 * failure (unconfigured model, Replicate down, fetch error); otherwise runs the
 * deterministic path directly. Returns the two R2 keys and which path produced them.
 */
export async function generateMatte(
	capture: RgbaImage,
	corners: NormalizedCorners,
	params: ReframeParams,
	opts: { useAi: boolean },
): Promise<{
	shadowKey: string;
	cutoutKey: string;
	source: "ai" | "deterministic";
}> {
	if (opts.useAi) {
		try {
			const keys = await storeMatte(await matteAI(capture, corners, params));
			return { ...keys, source: "ai" };
		} catch (err) {
			console.warn("matte: AI path failed, falling back to deterministic", err);
		}
	}
	const px = toPixelCorners(corners, capture.width, capture.height);
	const result = matteFromCorners(capture, px, matteOptions(params));
	const keys = await storeMatte(result);
	return { ...keys, source: "deterministic" };
}

/**
 * Load a capture from R2 and generate its matte — the convenience the record server
 * fns call (the square reframe loads separately; the extra decode is negligible next
 * to a matte run). Throws if the capture is missing.
 */
export async function generateMatteFromCapture(
	capturePhotoKey: string,
	corners: NormalizedCorners,
	params: ReframeParams,
	opts: { useAi: boolean },
): Promise<{
	shadowKey: string;
	cutoutKey: string;
	source: "ai" | "deterministic";
}> {
	return generateMatte(
		await loadCapture(capturePhotoKey),
		corners,
		params,
		opts,
	);
}
