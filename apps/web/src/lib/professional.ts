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
	PRESIZED_QUALITY,
	PRESIZED_WIDTHS,
	presizedKey,
	withPresizedKeys,
} from "#/lib/photo-variants";
import {
	DEFAULT_REFRAME_PARAMS,
	parseReframeParams,
	type ReframeParams,
} from "#/lib/reframe-params";
import {
	type CornerBand,
	cropBoxFor,
	type NormalizedCorners,
	parseCornerBand,
	toCropCorners,
	trimFor,
} from "#/lib/sleeve-corners";

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
 * admin corner editor (a fresh capture starts from the full frame), stored on the row
 * as {@link NormalizedCorners}. Given those corners this module:
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

// The most of a capture ever decoded into the isolate, on the longest side. Photon holds
// an image twice while decoding (its WASM buffer and the JS copy) and WASM memory never
// shrinks, so this bounds the generation isolate's peak whatever the capture size: a
// 3072px capture decoded whole would be ~38 MB a copy, against 128 MB.
const CAPTURE_DECODE_MAX = 2048;
// Padding around the sleeve's bounding box when cropping, as a fraction of the image.
const CROP_MARGIN = 0.02;

/**
 * Load the part of a capture around the band's inner quad, decoded at up to
 * {@link CAPTURE_DECODE_MAX}. The Images binding crops and scales off the JS heap, so
 * the sleeve gets the full decode budget and a large capture never decodes in full.
 * Returns the decoded crop and the band re-expressed in the crop's coordinates; the
 * caller's band (full-image coordinates) is what gets stored.
 */
export async function loadCaptureRegion(
	capturePhotoKey: string,
	band: CornerBand,
): Promise<{ capture: RgbaImage; band: CornerBand }> {
	const read = async () => {
		const object = await env.PHOTOS.get(capturePhotoKey);
		if (!object)
			throw new Error(`capture photo missing in R2: ${capturePhotoKey}`);
		return object.body;
	};
	const info = await env.IMAGES.info(await read());
	if (!("width" in info)) {
		throw new Error(`capture is not a raster image: ${capturePhotoKey}`);
	}
	const box = cropBoxFor(band.inner, info.width, info.height, CROP_MARGIN);
	const out = await env.IMAGES.input(await read())
		.transform({
			trim: trimFor(box, info.width, info.height),
			width: CAPTURE_DECODE_MAX,
			height: CAPTURE_DECODE_MAX,
			fit: "scale-down",
		})
		.output({ format: "image/webp", quality: 92 });
	return {
		capture: decodeRgba(new Uint8Array(await out.response().arrayBuffer())),
		band: {
			inner: toCropCorners(band.inner, box, info.width, info.height),
			outer: toCropCorners(band.outer, box, info.width, info.height),
		},
	};
}

/**
 * The core pixel work: warp the decoded `capture` to a square using the sleeve `corners`,
 * pad/tone per the {@link ReframeParams} knobs, canonicalise to a webp via the
 * Images binding, and store it under `professional/` (plus its pre-sized copies).
 * Returns the new R2 key.
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
	try {
		await storePresizedCopies(key, new Uint8Array(buffer));
	} catch (err) {
		// Nothing references `key` yet, so bin the master and any copies already
		// written before the caller's retry writes a fresh set under a new key.
		await env.PHOTOS.delete(withPresizedKeys(key)).catch(() => {});
		throw err;
	}

	return { key };
}

/**
 * Write the pre-sized copies `/api/photos/$` serves for `?w=` (see `photo-variants.ts`),
 * so a grid tile is a plain R2 read rather than an on-the-fly resize of the master.
 * Sequential, smallest first — each is a small Images call. A failure throws like the
 * master write does (the caller bins the partial set first); the retry regenerates the
 * whole set under a new key.
 */
async function storePresizedCopies(
	key: string,
	master: Uint8Array,
): Promise<void> {
	for (const width of PRESIZED_WIDTHS) {
		const out = await env.IMAGES.input(blobStream(master))
			.transform({ width, fit: "scale-down" })
			.output({ format: "image/webp", quality: PRESIZED_QUALITY });
		await env.PHOTOS.put(
			presizedKey(key, width),
			await out.response().arrayBuffer(),
			{ httpMetadata: { contentType: "image/webp" } },
		);
	}
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
	const region = await loadCaptureRegion(capturePhotoKey, band);
	return warpEncodeStore(region.capture, region.band, params);
}

/**
 * Reframe a record end-to-end for the queue (auto-on-capture + bulk). Decodes the capture
 * once, then uses the admin's stored corner band, or the full frame when there is none
 * (legacy single-quad rows are synthesised into a band at parse time). Returns the new
 * professional R2 key AND the band used, so the consumer can persist it. Does NOT touch
 * the DB itself.
 */
export async function professionalPipeline(
	record: Pick<
		Record,
		"capturePhotoKey" | "sleeveCornersJson" | "professionalParamsJson"
	>,
): Promise<{ professionalKey: string; band: CornerBand }> {
	if (!record.capturePhotoKey) {
		throw new Error("record has no capture photo to work from");
	}
	const band = parseCornerBand(record.sleeveCornersJson);
	const region = await loadCaptureRegion(record.capturePhotoKey, band);
	const { key: professionalKey } = await warpEncodeStore(
		region.capture,
		region.band,
		parseReframeParams(record.professionalParamsJson),
	);
	return { professionalKey, band };
}
