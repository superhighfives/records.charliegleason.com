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
	rasterizePolygon,
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
	upscaleImage,
} from "#/lib/professional";
import { matteToneFromParams, type ReframeParams } from "#/lib/reframe-params";
import { firstOutputUrl, runVersion } from "#/lib/replicate";
import type { NormalizedCorners } from "#/lib/sleeve-corners";

/**
 * The second render: a transparent, true-edged sleeve floating on breathing room with
 * a soft contact shadow — the sleeve as an *object in space*, next to the square hero.
 *
 * Both paths deskew the sleeve, cut it out, then perspective-warp it upright to fill the
 * frame ({@link warpMatteToSquare}) with a tight contact shadow. The cut is clamped just
 * inside the true sleeve edge — a few px, enough to keep the wood out of the soft edge but
 * far less than would flatten it — so ViTMatte's rounded corners and inward worn-edge dips
 * survive the warp: an upright card that still reads as a physical object, not a hard box.
 * Two ways to cut it out:
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

// Master resolution for the matte. Bumped above the 2000² square hero because the AI
// path super-resolves the sleeve (below) and can fill a bigger canvas with real detail;
// kept at 2400 (not higher) so the pure-JS warp/feather/shadow stay within the Worker's
// CPU + 128 MB memory budget. The sleeve is perspective-warped to fill most of the frame,
// with a small (4%) transparent margin left for the contact shadow.
const CANVAS_SIZE = 2400;
// The sleeve fills 96% of the square (a 2% transparent margin each side for the shadow).
const MARGIN = 0.02;
const CONTENT_SIZE = Math.round(CANVAS_SIZE * (1 - 2 * MARGIN));
// Feather (applied at content scale, kept small for a crisp edge) and a tight, dark
// down-right contact shadow (canvas scale) — so the sleeve reads as a card pressed
// against the surface.
const FEATHER = 2;
const SHADOW: ShadowOptions = {
	blur: Math.round(CANVAS_SIZE * 0.006),
	offsetX: Math.round(CANVAS_SIZE * 0.002),
	offsetY: Math.round(CANVAS_SIZE * 0.004),
	opacity: 0.55,
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
const TRIMAP_REFINE_SEARCH = Math.round(MODEL_SIZE * 0.05);
const TRIMAP_BAND = Math.round(MODEL_SIZE * 0.025);

// Bleed the sleeve's colour this many px into the transparent margin before the warp, so
// the soft edge blends cover-into-cover instead of the wood just outside it (the tan
// fringe). This kills the fringe *without* choking the alpha, so the model's ragged edge
// and rounded/worn corners stay fully intact. Scaled for the hi-res (~2800) AI content.
const MATTE_BLEED = 10;

// How far the sleeve is straightened toward a perfect upright rectangle (0…1). Half:
// upright-ish but keeping some of the real photographic lean, so it doesn't read as a flat
// dead-square swatch. 1 = fully square, 0 = the sleeve's natural perspective.
const MATTE_STRAIGHTEN = 0.5;

// Resolution the matting model computes its alpha at (its `max_size` input). Higher than
// its 1280 default so the *edge* is crisper — the alpha is the blurriest link, since we
// upsample it over the super-resolved sleeve. 2048 is the cog's ceiling.
const MATTE_MODEL_MAX_SIZE = 2048;

// Cap for the ESRGAN super-resolve of the (opaque) sleeve+wood content on the AI path.
// Keeps the hi-res RGBA buffers the pure-JS re-cut allocates under the Worker's memory
// budget (2800² RGBA ≈ 31 MB) while still giving the 2400 canvas real detail to sample.
const MATTE_ESRGAN_MAX = 2800;

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
		straighten: MATTE_STRAIGHTEN,
		bleed: MATTE_BLEED,
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
 * Bilinearly resample a single-channel mask to `tw`×`th`, allocating only the output
 * (no big RGBA temporaries) so the hi-res re-cut stays inside the Worker's memory budget.
 */
function resizeMask(
	mask: Uint8ClampedArray,
	w: number,
	h: number,
	tw: number,
	th: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(tw * th);
	for (let y = 0; y < th; y++) {
		const sy = ((y + 0.5) * h) / th - 0.5;
		const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
		const y1 = Math.min(h - 1, y0 + 1);
		const fy = sy - Math.floor(sy);
		for (let x = 0; x < tw; x++) {
			const sx = ((x + 0.5) * w) / tw - 0.5;
			const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
			const x1 = Math.min(w - 1, x0 + 1);
			const fx = sx - Math.floor(sx);
			const top =
				mask[y0 * w + x0] + (mask[y0 * w + x1] - mask[y0 * w + x0]) * fx;
			const bot =
				mask[y1 * w + x0] + (mask[y1 * w + x1] - mask[y1 * w + x0]) * fx;
			out[y * tw + x] = top + (bot - top) * fy;
		}
	}
	return out;
}

/**
 * The paid matte: deskew the sleeve upright with a wood margin, build a trimap from the
 * picked corners, run image + trimap through the pinned ViTMatte deployment, then
 * super-resolve the sleeve and composite the model's alpha over those higher-res pixels.
 * Throws if the model isn't configured or errors — the caller falls back to deterministic.
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
		max_size: MATTE_MODEL_MAX_SIZE,
	});
	const url = firstOutputUrl(prediction.output);
	if (!url) throw new Error("matting model returned no image");

	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetching the matte failed (${res.status})`);
	const model = decodeRgba(new Uint8Array(await res.arrayBuffer()));

	// Clamp the model's alpha to the sleeve rectangle: kill anything beyond the edge (wood
	// the model kept, or a refine that reached too far) but don't erode inward, so the
	// model's ragged edge, rounded corners and worn-edge dips all survive. The wood fringe
	// that would otherwise ride the soft edge is handled by the colour bleed in the warp.
	//
	// Use the *intersection* of the refined edge and the admin's picked corners: refine can
	// pull the cut tighter (inward) for a clean line, but never push it outward past where
	// the admin drew — a low-contrast mat/wood edge can fool refine into snapping onto a
	// wood-plank seam beyond the sleeve, and that overshoot must never survive into the
	// matte. The cut is tight to the pick (no outward grow): the corners often sit right on
	// the mat/wood boundary, so any outward slack there pulls in a wedge of floor the dark
	// model can't tell from the dark mat. The feather blends against the mat *inside* the
	// cut, and the colour-bleed covers the transparent side, so a tight cut still softens.
	const refinedMask = rasterizePolygon(refined, content.width, content.height);
	const pickedMask = rasterizePolygon(inset, content.width, content.height);
	const clamp = new Uint8ClampedArray(refinedMask.length);
	for (let i = 0; i < clamp.length; i++)
		clamp[i] = refinedMask[i] && pickedMask[i] ? 255 : 0;
	const raw = maskFromModelOutput(model, content.width, content.height);
	for (let i = 0; i < raw.length; i++) if (!clamp[i]) raw[i] = 0;
	// Largest blob only (drop stray specks), lightly feathered for a clean anti-aliased edge.
	const feathered = featherMask(
		keepLargestComponent(raw, content.width, content.height),
		content.width,
		content.height,
		FEATHER,
	);

	// Super-resolve the opaque sleeve+wood content, then re-cut it with the clamped alpha
	// scaled up to match — real-pixel RGB at ESRGAN resolution over a model-quality edge.
	// ESRGAN drops alpha, so we re-attach our own.
	const hi = await upscaleImage(content, { maxSize: MATTE_ESRGAN_MAX });
	const scale = hi.width / content.width;
	applyMask(
		hi,
		resizeMask(feathered, content.width, content.height, hi.width, hi.height),
	);
	// Perspective-warp the hi-res cutout upright by the refined quad so it fills the frame
	// as a card, keeping the ragged edge/corners (the colour bleed keeps wood out), then
	// tone + tight shadow.
	const quadHi = refined.map(
		([x, y]) => [x * scale, y * scale] as [number, number],
	) as typeof refined;
	return warpMatteToSquare(hi, quadHi, matteOptions(params));
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
