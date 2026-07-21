import { env } from "cloudflare:workers";

import { bytesToBase64 } from "#/lib/image-data";
import {
	CANVAS_SIZE,
	CLAMP_LOWCONF_INSET,
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
import { renderMatteInContainer } from "#/lib/matte-container";
import {
	grayToRgba,
	maskFromModelOutput,
	resizeMask,
} from "#/lib/matte-pixels";
import {
	applyMask,
	buildTrimapFromBand,
	deskewBandPadded,
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
import {
	blobStream,
	decodeRgba,
	encodePng,
	loadCapture,
	upscaleImage,
} from "#/lib/professional";
import type { ReframeParams } from "#/lib/reframe-params";
import { firstOutputUrl, runVersion } from "#/lib/replicate";
import type { CornerBand } from "#/lib/sleeve-corners";

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
 *   - the FREE, deterministic {@link matteFromBand} (edge-snap silhouette) — also
 *     the automatic fallback when the paid path is unavailable;
 *   - the PAID {@link matteAI}: deskew the sleeve upright with a wood margin and run
 *     image + trimap through a pinned ViTMatte deployment. The trimap comes straight
 *     from the admin's corner BAND (inner quad = certified sleeve = definite foreground,
 *     outer quad = certified background boundary, the band between = unknown) — a
 *     hand-drawn trimap, not an inferred one. That's the whole point: the model can only
 *     decide the unknown band, so it physically can't cut into the artwork's depicted
 *     subject or keep a neighbouring record — the exact failures a free-running
 *     segmenter hits. Its alpha is composited over our *own* capture pixels
 *     (model-quality edge, real pixels).
 *
 * Each run stores TWO webp-with-alpha objects — a shadow variant (primary, for the
 * floating look) and a pure cutout (for compositing onto any background) — under
 * `alpha/`, served by the existing `/api/photos/$` passthrough. Server-only.
 */

// The matte's tunable constants + `matteOptions` live in `matte-config.ts` — a pure module
// shared with the standalone matte container so the two renderers can't drift. The prose
// behind each knob stays next to the code that reads it, below.

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

/** Store two already-encoded webp matte variants under a shared `alpha/{uuid}` stem. */
async function storeMatteBytes(
	// `ArrayBuffer` from the Worker's `encodeWebp`; `Uint8Array` from the container response.
	shadowBuf: ArrayBuffer | Uint8Array,
	cutoutBuf: ArrayBuffer | Uint8Array,
): Promise<{ shadowKey: string; cutoutKey: string }> {
	const uuid = crypto.randomUUID();
	const shadowKey = `alpha/${uuid}.webp`;
	const cutoutKey = `alpha/${uuid}-cutout.webp`;
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

/** Encode both matte variants (Images binding) then store them. */
async function storeMatte(
	result: MatteResult,
): Promise<{ shadowKey: string; cutoutKey: string }> {
	const [shadowBuf, cutoutBuf] = await Promise.all([
		encodeWebp(result.shadow),
		encodeWebp(result.cutout),
	]);
	return storeMatteBytes(shadowBuf, cutoutBuf);
}

/**
 * The paid matte: deskew the sleeve upright with a wood margin, hand the model the
 * band as a trimap (the band IS the trimap — inner locked foreground, outer locked
 * background, between unknown), run image + trimap through the pinned ViTMatte
 * deployment, then super-resolve the sleeve and composite the model's alpha over those
 * higher-res pixels. Throws if the model isn't configured or errors — the caller falls
 * back to deterministic.
 */
async function matteAI(
	capture: RgbaImage,
	band: CornerBand,
	params: ReframeParams,
): Promise<MatteResult> {
	if (!MATTE_MODEL_VERSION) throw new Error("matting model not configured");
	const pxBand: PixelBand = {
		inner: toPixelCorners(band.inner, capture.width, capture.height),
		outer: toPixelCorners(band.outer, capture.width, capture.height),
	};
	// Deskew upright with a wood margin around the outer quad; both quads come back
	// mapped into the deskewed frame.
	const { content, inner, outer } = deskewBandPadded(
		capture,
		pxBand,
		MODEL_SIZE,
		MODEL_PAD,
	);
	// Find the straight-line edge inside the band (colour-gradient search from the band
	// midline, bounded per edge by the inner/outer quads, with a per-edge confidence; an
	// ambiguous edge reverts to the midline). This drives the final warp and the
	// low-confidence clamp — the model itself gets the whole band via the trimap.
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

	// Clamp the model's alpha per edge: a confident edge lets the alpha roam the whole
	// band up to the OUTER quad — the true edge is certified to lie inside it, so worn
	// corners, dips and bows anywhere in the band all survive (the old "never past the
	// pick" rule is gone; the outer quad is the new, human-certified hard wall). A
	// low-confidence edge (no discernible boundary in the band) instead clamps a hair
	// inside the band midline: with nothing to see there, a crisp straight cut at the
	// admin's best guess beats trusting the model in the dark. Never erode a confident
	// edge inward — the model's ragged edge is the point. The wood fringe that would
	// otherwise ride the soft edge is handled by the colour bleed in the warp.
	const clampQuad = offsetQuad(
		mid,
		confidence.map((c, e) =>
			c >= EDGE_CONFIDENCE_MIN ? toOuter[e] : -CLAMP_LOWCONF_INSET,
		) as [number, number, number, number],
	);
	const clamp = rasterizePolygon(clampQuad, content.width, content.height);
	const raw = maskFromModelOutput(model, content.width, content.height);
	// The model output is fully consumed into `raw` — release its RGBA buffer (up to
	// ~2048² ≈ 16 MB) now so it isn't pinned through the hi-res enhance + warp tail below.
	model.data = new Uint8ClampedArray(0);
	for (let i = 0; i < raw.length; i++) if (!clamp[i]) raw[i] = 0;
	// Colour-statistical backstop: strip any background-coloured sliver that survived
	// the band + model + clamp (dark wood the model mistook for a dark mat, say).
	// Sampled per capture with both rings on certified ground truth — background
	// outside the outer quad, sleeve border just inside the inner quad. No-op when
	// the two colour distributions are inseparable.
	vetoBackgroundAlpha(content, raw, refined, inner, {
		depth: VETO_DEPTH,
		ring: VETO_RING,
		bgQuad: outer,
		fgInset: VETO_FG_INSET,
	});
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
	// `content`'s pixels are done — everything below needs only its dimensions. Release the
	// buffer (≈10 MB) before the warp allocates the full-canvas output, to shave the peak.
	const cw = content.width;
	const ch = content.height;
	content.data = new Uint8ClampedArray(0);
	const scale = hi.width / cw;
	applyMask(hi, resizeMask(feathered, cw, ch, hi.width, hi.height));
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
 * paid matting model; on any failure (unconfigured model, Replicate down, fetch error)
 * it falls back to the free deterministic silhouette — UNLESS `fallback: false`, in which
 * case the AI failure rethrows and no deterministic pass runs in this isolate. That's how
 * the Apply pipeline keeps the two heavy renders apart: the AI stage runs `fallback: false`
 * so a failed AI attempt never stacks its buffers with the (larger, ~3000² deskew)
 * deterministic render on one 128 MB isolate — the deterministic fallback is re-enqueued to
 * a fresh isolate instead (see `professional-pipeline.ts`). Without `useAi`, the
 * deterministic path runs directly. Returns the two R2 keys and which path produced them.
 */
export async function generateMatte(
	capture: RgbaImage,
	band: CornerBand,
	params: ReframeParams,
	opts: { useAi: boolean; fallback?: boolean },
): Promise<{
	shadowKey: string;
	cutoutKey: string;
	source: "ai" | "deterministic";
}> {
	if (opts.useAi) {
		try {
			const keys = await storeMatte(await matteAI(capture, band, params));
			return { ...keys, source: "ai" };
		} catch (err) {
			// `fallback: false` — don't run the deterministic render in this (AI) isolate;
			// let the caller re-enqueue it to a clean heap. Prevents the two big renders
			// from sharing one 128 MB isolate and OOMing.
			if (opts.fallback === false) throw err;
			console.warn("matte: AI path failed, falling back to deterministic", err);
		}
	}
	const pxBand: PixelBand = {
		inner: toPixelCorners(band.inner, capture.width, capture.height),
		outer: toPixelCorners(band.outer, capture.width, capture.height),
	};
	const result = matteFromBand(capture, pxBand, matteOptions(params));
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
	band: CornerBand,
	params: ReframeParams,
	opts: { useAi: boolean; fallback?: boolean },
): Promise<{
	shadowKey: string;
	cutoutKey: string;
	source: "ai" | "deterministic";
}> {
	return generateMatte(await loadCapture(capturePhotoKey), band, params, opts);
}

// HEIF/HEIC brand codes (the `ftyp` box's major brand). iPhone captures stored as their
// raw original — the fallback when Image Transformations were unavailable at capture time —
// can be HEIC, which sharp's prebuilt libvips can't decode. The Images binding can, so those
// (and only those) get normalised to webp before the container call.
const HEIC_BRANDS = new Set([
	"heic",
	"heix",
	"hevc",
	"hevx",
	"heim",
	"heis",
	"hevm",
	"hevs",
	"mif1",
	"msf1",
]);

/** Sniff a HEIC/HEIF file by its ISO-BMFF `ftyp` box (bytes 4–8 "ftyp", 8–12 the brand). */
function looksLikeHeic(bytes: Uint8Array): boolean {
	if (bytes.length < 12) return false;
	const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
	if (box !== "ftyp") return false;
	const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
	return HEIC_BRANDS.has(brand);
}

/**
 * The container equivalent of {@link generateMatteFromCapture}: hand the capture bytes to the
 * matte container (which does the memory-heavy render off the 128 MB isolate — see
 * `containers/matte/`), then store the two webp variants it returns and hand back the same
 * `{ shadowKey, cutoutKey, source }` shape. `mode: "ai"` throws on failure (no in-container
 * fallback), so the queue's AI-preferred retry logic is unchanged; `mode: "deterministic"`
 * runs the free silhouette. The capture is sent encoded (not decoded) so the payload stays a
 * ~2 MB webp; sharp decodes it container-side — except a raw HEIC original (sharp can't read
 * those), which is normalised to a bounded webp via the Images binding first.
 */
export async function generateMatteViaContainer(
	capturePhotoKey: string,
	band: CornerBand,
	params: ReframeParams,
	mode: "ai" | "deterministic",
): Promise<{
	shadowKey: string;
	cutoutKey: string;
	source: "ai" | "deterministic";
}> {
	const object = await env.PHOTOS.get(capturePhotoKey);
	if (!object)
		throw new Error(`capture photo missing in R2: ${capturePhotoKey}`);
	const raw = new Uint8Array(await object.arrayBuffer());
	// Common case (webp/jpeg/png): send untouched, keeping the container path off the Images
	// binding. HEIC: transcode to a bounded webp first so sharp can decode it container-side.
	const capture = looksLikeHeic(raw)
		? new Uint8Array(
				await (
					await env.IMAGES.input(blobStream(raw))
						.transform({ width: 2048, height: 2048, fit: "scale-down" })
						.output({ format: "image/webp", quality: 92 })
				)
					.response()
					.arrayBuffer(),
			)
		: raw;
	const result = await renderMatteInContainer({ capture, band, params, mode });
	const keys = await storeMatteBytes(result.shadow, result.cutout);
	return { ...keys, source: result.source };
}
