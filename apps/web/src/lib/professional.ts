import { env } from "cloudflare:workers";
import { PhotonImage } from "@cf-wasm/photon";

import type { Record } from "#/db/schema";
import {
	applyPolish,
	type RgbaImage,
	reframeFromCorners,
	toPixelCorners,
} from "#/lib/photo-processing";
import {
	DEFAULT_REFRAME_PARAMS,
	parseReframeParams,
	type ReframeParams,
} from "#/lib/reframe-params";
import {
	bandFromQuad,
	type CornerBand,
	DEFAULT_BAND,
	type NormalizedCorners,
	parseCornerBand,
} from "#/lib/sleeve-corners";
import {
	detectSleeveCornersBest,
	type SleeveDetection,
} from "#/lib/sleeve-detect-wasm";

/**
 * Turn a rough iPhone capture into a clean, straight-on studio shot of the physical
 * sleeve — by *processing* the real photo, never repainting it, and never guessing at
 * the sleeve with an AI segmenter.
 *
 * An earlier pipeline sent the capture through a generative image editor (FLUX.2) to
 * "restyle" it, which took creative liberties (redrew artwork, flattened paper texture).
 * A later one tried to segment the sleeve with a promptable model (grounded_sam) — but
 * a photo of an album cover *looks like the scene the cover depicts*, so every segmenter
 * locked onto the artwork's subject (a figure, a building), never the flat rectangle.
 *
 * So the sleeve's four corners are picked deterministically instead: by hand in the
 * admin corner editor (auto-seeded by the {@link detectSleeveCornersBest} pass), stored on
 * the row as {@link NormalizedCorners}. Given those corners this module:
 *
 *   1. perspective-warps the real capture pixels onto a square — cropping, squaring and
 *      de-keystoning in one step (a classic "document scanner" homography);
 *   2. foreground-aware auto-levels + grey-world white balance normalise exposure and
 *      neutralise the ambient colour cast, so every shot looks consistent.
 *
 * The pixel math lives in {@link reframeFromCorners} (pure, unit-tested); Photon decodes
 * the capture and re-encodes the result, and the Images binding canonicalises to a
 * webp (like the cover pipeline) before storing under `professional/`.
 *
 * The whole thing is free and deterministic, so it re-runs on demand whenever the
 * admin nudges the corners or the {@link ReframeParams} tone/polish knobs. (A paid
 * Real-ESRGAN "Enhance" pass used to follow; it upscaled from a 1024px downscale of
 * the 2000px square, so it was retired rather than kept as a sharpening step.)
 *
 * Server-only (pulls in `cloudflare:workers`); never import from a client route — the
 * shared knob/corner types + defaults live in `reframe-params.ts` / `sleeve-corners.ts`.
 */

// Final framing — the warped sleeve fills the whole square canvas, edge to edge.
const CANVAS_SIZE = 2000;

// Sharpen strength for the final Images pass. Gentle — just enough to counter the
// bilinear softening from the warp, not enough to crunch the halftone.
const FINAL_SHARPEN = 1.0;

/** A fresh single-use stream over the same bytes (the Images binding consumes one per call). */
export function blobStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([bytes as BlobPart]).stream();
}

/** Decode encoded image bytes to an {@link RgbaImage} via Photon. */
export function decodeRgba(bytes: Uint8Array): RgbaImage {
	const img = PhotonImage.new_from_byteslice(bytes);
	try {
		return {
			data: new Uint8ClampedArray(img.get_raw_pixels()),
			width: img.get_width(),
			height: img.get_height(),
		};
	} finally {
		img.free();
	}
}

/** Encode an {@link RgbaImage} to PNG bytes via Photon (preserves alpha). */
export function encodePng(image: RgbaImage): Uint8Array {
	const img = new PhotonImage(
		new Uint8Array(
			image.data.buffer,
			image.data.byteOffset,
			image.data.byteLength,
		),
		image.width,
		image.height,
	);
	try {
		return img.get_bytes();
	} finally {
		img.free();
	}
}

// A normalised capture is a ~2048² webp, comfortably under ~2 MB. Anything materially
// larger is the raw-original storage fallback (`storeCapturePhotoFromR2`, when Image
// Transformations are unavailable) — a straight-off-the-phone HEIC/JPEG that would decode
// to a 40+ MB RGBA buffer and, stacked with the warp's other buffers, OOM the
// generation isolate outright. Route only those through the Images binding first (it
// decodes off the JS heap) to bound the decode to CAPTURE_DECODE_MAX; the normal path
// decodes the stored bytes directly with zero added latency.
const CAPTURE_DECODE_MAX = 2048;
const CAPTURE_RAW_BYTES_MAX = 2_500_000;

/** Load + decode a capture from R2 to an {@link RgbaImage} (throws if it's missing). */
export async function loadCapture(capturePhotoKey: string): Promise<RgbaImage> {
	const object = await env.PHOTOS.get(capturePhotoKey);
	if (!object)
		throw new Error(`capture photo missing in R2: ${capturePhotoKey}`);
	if (object.size > CAPTURE_RAW_BYTES_MAX) {
		const out = await env.IMAGES.input(object.body)
			.transform({
				width: CAPTURE_DECODE_MAX,
				height: CAPTURE_DECODE_MAX,
				fit: "scale-down",
			})
			.output({ format: "image/webp", quality: 92 });
		return decodeRgba(new Uint8Array(await out.response().arrayBuffer()));
	}
	return decodeRgba(new Uint8Array(await object.arrayBuffer()));
}

/**
 * The core pixel work: warp the decoded `capture` to a square using the sleeve `corners`,
 * pad/tone per the {@link ReframeParams} knobs, canonicalise to a webp via the
 * Images binding, and store it under `professional/`. Returns the new R2 key.
 */
async function warpEncodeStore(
	capture: RgbaImage,
	band: CornerBand,
	params: ReframeParams,
): Promise<{ key: string }> {
	const p = { ...DEFAULT_REFRAME_PARAMS, ...params };
	const { image } = reframeFromCorners(
		capture,
		// The cover is opaque edge-to-edge, so it warps from the band's INNER quad —
		// certified wholly on the sleeve, so it can never drag a sliver of background
		// into its border.
		toPixelCorners(band.inner, capture.width, capture.height),
		{
			canvasSize: CANVAS_SIZE,
			// The sleeve fills the whole canvas — no transparent margin.
			contentSize: CANVAS_SIZE,
			// `skipTone` keeps the warped capture at its original exposure; otherwise the
			// white-balance/levels knobs feed auto-tone.
			tone: p.skipTone
				? false
				: { wbStrength: p.wbStrength, lowPct: p.lowPct, highPct: p.highPct },
		},
	);

	// The "polish" factors (saturation/contrast/gamma) go on in pixels — the same
	// math (and order) the live client preview uses — so the stored image matches
	// what the admin saw, and it applies identically in local dev (where the Images
	// binding's colour transforms are a no-op) and production. 1.0 = no-op per factor.
	applyPolish(image, p.saturation, p.contrast, p.gamma);

	const png = encodePng(image);
	// Final encode pass: gentle sharpen to counter the warp's bilinear softening, then
	// canonicalise to webp. (Colour is already baked into the pixels above.)
	const out = await env.IMAGES.input(blobStream(png))
		.transform({ sharpen: FINAL_SHARPEN })
		.output({ format: "image/webp", quality: 92 });
	const buffer = await out.response().arrayBuffer();

	const key = `professional/${crypto.randomUUID()}.webp`;
	await env.PHOTOS.put(key, buffer, {
		httpMetadata: { contentType: "image/webp" },
	});

	return { key };
}

/**
 * The FREE, deterministic reframe with explicit corners — the interactive path (the
 * corner editor's Apply). Reads the capture, warps it to the given `corners` + knobs, and
 * stores the result. Re-runnable at no cost, since nothing is regenerated. Returns the key.
 */
export async function reframeFromCapture(
	capturePhotoKey: string,
	band: CornerBand,
	params: ReframeParams = {},
): Promise<{ key: string }> {
	return warpEncodeStore(await loadCapture(capturePhotoKey), band, params);
}

/**
 * Run the {@link detectSleeveCornersBest} seed against a stored capture on demand — the
 * corner editor's "Detect corners" button. Returns the detected corners plus a confidence
 * score and which detector won (so the editor can tell the admin how hard to scrutinise the
 * seed), or `null` when neither detector can separate the sleeve from the background (the
 * caller leaves the handles put).
 */
export async function detectCaptureCorners(
	capturePhotoKey: string,
): Promise<SleeveDetection | null> {
	return detectSleeveCornersBest(await loadCapture(capturePhotoKey));
}

/**
 * Reframe a record end-to-end for the queue (auto-on-capture + bulk). Decodes the capture
 * once, then picks the corner band: the admin's stored band if there is one (legacy
 * single-quad rows are synthesised into a band at parse time), otherwise a band seeded
 * from a best-effort {@link detectSleeveCornersBest} pass (full-frame default when
 * detection can't find the sleeve). Returns the new professional R2 key AND the band used,
 * so the consumer can persist it — that seed is what the corner editor opens pre-cropped
 * to. Does NOT touch the DB itself.
 */
export async function professionalPipeline(
	record: Pick<
		Record,
		"capturePhotoKey" | "sleeveCornersJson" | "professionalParamsJson"
	>,
): Promise<{
	professionalKey: string;
	band: CornerBand;
	detection: SleeveDetection | null;
}> {
	if (!record.capturePhotoKey) {
		throw new Error("record has no capture photo to work from");
	}
	const capture = await loadCapture(record.capturePhotoKey);
	// Respect a stored band; otherwise seed by detecting the sleeve (full-frame fallback).
	// `detection` is non-null only when we actually ran the detector (no stored band), so the
	// caller can persist its confidence/source for the on-open badge and the review queue.
	let band: CornerBand;
	let detection: SleeveDetection | null = null;
	if (record.sleeveCornersJson) {
		band = parseCornerBand(record.sleeveCornersJson);
	} else {
		detection = await detectSleeveCornersBest(capture);
		band = detection ? bandFromQuad(detection.corners) : DEFAULT_BAND;
	}
	const { key: professionalKey } = await warpEncodeStore(
		capture,
		band,
		parseReframeParams(record.professionalParamsJson),
	);
	return { professionalKey, band, detection };
}
