import { env } from "cloudflare:workers";
import { PhotonImage } from "@cf-wasm/photon";

import type { Record } from "#/db/schema";
import { bytesToBase64 } from "#/lib/image-data";
import {
	applyPolish,
	detectSleeveCorners,
	type RgbaImage,
	reframeFromCorners,
	toPixelCorners,
} from "#/lib/photo-processing";
import {
	DEFAULT_REFRAME_PARAMS,
	parseReframeParams,
	type ReframeParams,
} from "#/lib/reframe-params";
import { firstOutputUrl, runVersion } from "#/lib/replicate";
import { NonRetryableError, withRetry } from "#/lib/retry";
import {
	bandFromQuad,
	type CornerBand,
	DEFAULT_BAND,
	type NormalizedCorners,
	parseCornerBand,
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
 * admin corner editor (auto-seeded by the lightweight {@link detectSleeveCorners} pass),
 * stored on the row as {@link NormalizedCorners}. Given those corners this module:
 *
 *   1. perspective-warps the real capture pixels onto a square — cropping, squaring and
 *      de-keystoning in one step (a classic "document scanner" homography);
 *   2. foreground-aware auto-levels + grey-world white balance normalise exposure and
 *      neutralise the ambient colour cast, so every shot looks consistent.
 *
 * The pixel math lives in {@link reframeFromCorners} (pure, unit-tested); Photon decodes
 * the capture and re-encodes the result, and the Images binding canonicalises to a
 * webp-with-alpha (like the cover pipeline) before storing under `professional/`.
 *
 * The reframe itself is free and deterministic, so it re-runs on demand whenever the
 * admin nudges the corners or the {@link ReframeParams} tone/polish knobs. The only
 * paid step is the optional, on-demand "Enhance" ({@link upscaleProfessional}), which
 * super-resolves an already-reframed image through Real-ESRGAN on Replicate.
 *
 * Server-only (pulls in `cloudflare:workers`); never import from a client route — the
 * shared knob/corner types + defaults live in `reframe-params.ts` / `sleeve-corners.ts`.
 */

// Final framing — the warped sleeve fills the whole square canvas, edge to edge.
const CANVAS_SIZE = 2000;

// Sharpen strength for the final Images pass. Gentle — just enough to counter the
// bilinear softening from the warp, not enough to crunch the halftone.
const FINAL_SHARPEN = 1.0;

// On-demand "Enhance": Real-ESRGAN super-resolution. Faithful (no diffusion, so it
// sharpens + denoises without inventing cover art / text), cheap, and quick. Pinned
// to a known version so the input schema can't shift under us.
const REAL_ESRGAN_VERSION =
	"b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8";
// This runs on Replicate's SHARED T4 (~14.5 GiB), and the underlying network is a fixed
// x4 architecture: peak VRAM is the x4 forward pass over the *input*, so input pixels —
// not the `scale` param, which only resizes afterwards — govern OOM. 1400² x4 = 5600²
// (31M px) tips the T4 over (see the CUDA-OOM Sentry issues), and we then throw most of
// it away by capping to UPSCALE_MAX anyway. 1024² (1.05M px) x4 = 4096² lands right at
// the cap, so the stored master is unchanged while GPU activation memory drops ~47%.
const UPSCALE_INPUT_MAX = 1024;
// 4× matches the model's native scale (asking for less wouldn't save VRAM — the x4 tensor
// is allocated regardless — and would only soften the result). 1024 → 4096px master.
const UPSCALE_FACTOR = 4;
// Bound the stored master so a big upscale can't balloon R2. Set to the exact x4 output
// (1024 × 4) so the model's native result passes through without a redundant resample.
const UPSCALE_MAX = 4096;

/** A fresh single-use stream over the same bytes (the Images binding consumes one per call). */
export function blobStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([bytes as BlobPart]).stream();
}

const IMAGES_FETCH_ATTEMPTS = 3;
const IMAGES_RETRY_BASE_MS = 400;

/**
 * Fetch a Replicate output image by URL and re-encode it to a bounded square webp through
 * the Images binding, returning the encoded bytes. Shared by {@link upscaleImage} and
 * {@link upscaleProfessional} — the two ESRGAN-output call sites.
 *
 * Two subtleties this centralises:
 *   - Buffer the CDN response to bytes BEFORE the transform. Streaming a live `res.body`
 *     straight into Images lets the (slow) transform pace the upstream read until the idle
 *     replicate.delivery connection is reaped, and the binding throws an uncatchable-looking
 *     "Network connection lost." mid-transform (Sentry culprit `images-api
 *     throwErrorIfErrorResponse`). Draining first hands Images stable in-memory input.
 *   - Retry that transient locally (a few cheap re-fetches of the same URL) rather than
 *     re-running the whole ~90s Replicate chain via the queue's outer retry. A non-2xx
 *     response (expired CDN link, 401/403 config) won't fix itself, so it's thrown
 *     {@link NonRetryableError} and surfaces immediately — like `discogsFetch`'s 401/404
 *     handling — instead of burning all attempts on it.
 */
async function fetchScaledWebp(
	url: string,
	maxSize: number,
): Promise<ArrayBuffer> {
	return withRetry(
		async () => {
			const res = await fetch(url);
			if (!res.ok) {
				throw new NonRetryableError(
					`Fetching the upscaled image failed (${res.status})`,
				);
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			const out = await env.IMAGES.input(blobStream(bytes))
				.transform({ width: maxSize, height: maxSize, fit: "scale-down" })
				.output({ format: "image/webp", quality: 92 });
			return out.response().arrayBuffer();
		},
		{ attempts: IMAGES_FETCH_ATTEMPTS, baseMs: IMAGES_RETRY_BASE_MS },
	);
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
// larger is the raw-original storage fallback (`storeCapturePhoto`, when Image
// Transformations are unavailable) — a straight-off-the-phone HEIC/JPEG that would decode
// to a 40+ MB RGBA buffer and, stacked with the matte pipeline's other buffers, OOM the
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
 * pad/tone per the {@link ReframeParams} knobs, canonicalise to a webp-with-alpha via the
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
		// into its border. The matte paths use the full band (they resolve the true edge).
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
 * Super-resolve an in-memory RGBA image through Real-ESRGAN — the reusable core the
 * matte pipeline shares with {@link upscaleProfessional}. Downscales under the model's
 * input-pixel ceiling first, ships it as a data URI, and returns the model's (larger)
 * output decoded back to RGBA, capped at `maxSize` (default {@link UPSCALE_MAX}) so a
 * big result can't run the pure-JS matte math too hot or blow the Worker's memory.
 * Opaque input only — ESRGAN drops alpha, so callers re-attach their own.
 */
export async function upscaleImage(
	img: RgbaImage,
	opts: { maxSize?: number } = {},
): Promise<RgbaImage> {
	const cap = opts.maxSize ?? UPSCALE_MAX;
	const fitted = await env.IMAGES.input(blobStream(encodePng(img)))
		.transform({
			width: UPSCALE_INPUT_MAX,
			height: UPSCALE_INPUT_MAX,
			fit: "scale-down",
		})
		.output({ format: "image/webp", quality: 92 });
	const fittedBytes = new Uint8Array(await fitted.response().arrayBuffer());
	const dataUri = `data:image/webp;base64,${bytesToBase64(fittedBytes)}`;

	const prediction = await runVersion(REAL_ESRGAN_VERSION, {
		image: dataUri,
		scale: UPSCALE_FACTOR,
		face_enhance: false,
	});
	const url = firstOutputUrl(prediction.output);
	if (!url) throw new Error("Replicate returned no upscaled image");
	return decodeRgba(new Uint8Array(await fetchScaledWebp(url, cap)));
}

/**
 * The PAID "Enhance" step: super-resolve an existing professional image (an R2 key)
 * through Real-ESRGAN and store the higher-res master under a fresh `professional/`
 * key. The model's GPU caps the input at ~2.1M pixels, so the full-size reframe is
 * first downscaled under that budget (Images binding), then shipped to Replicate as a
 * data URI (the R2 object isn't publicly reachable), and the upscaled result is
 * fetched back and canonicalised to a bounded webp — same format as everything else.
 * Returns the new key; throws on any Replicate/fetch/store failure so the caller can
 * leave the record's current cover untouched.
 */
export async function upscaleProfessional(
	professionalKey: string,
): Promise<{ key: string }> {
	const object = await env.PHOTOS.get(professionalKey);
	if (!object)
		throw new Error(`professional photo missing in R2: ${professionalKey}`);

	// Downscale under the model's input-pixel ceiling before sending. A no-op if the
	// source is already small enough; otherwise this is what the model upscales from.
	const fitted = await env.IMAGES.input(object.body)
		.transform({
			width: UPSCALE_INPUT_MAX,
			height: UPSCALE_INPUT_MAX,
			fit: "scale-down",
		})
		.output({ format: "image/webp", quality: 92 });
	const fittedBytes = new Uint8Array(await fitted.response().arrayBuffer());
	const dataUri = `data:image/webp;base64,${bytesToBase64(fittedBytes)}`;

	const prediction = await runVersion(REAL_ESRGAN_VERSION, {
		image: dataUri,
		scale: UPSCALE_FACTOR,
		// Album art, not portraits — GFPGAN face restoration would meddle with cover
		// faces/text, so leave it off for a faithful upscale.
		face_enhance: false,
	});
	const outputUrl = firstOutputUrl(prediction.output);
	if (!outputUrl) throw new Error("Replicate returned no upscaled image");

	// Same fetch-then-Images-transform as upscaleImage (this is the `[pro] enhance failed`
	// path) — see fetchScaledWebp for the buffer-before-transform + local-retry rationale.
	const buffer = await fetchScaledWebp(outputUrl, UPSCALE_MAX);

	const key = `professional/${crypto.randomUUID()}.webp`;
	await env.PHOTOS.put(key, buffer, {
		httpMetadata: { contentType: "image/webp" },
	});
	return { key };
}

/**
 * Run the lightweight {@link detectSleeveCorners} seed against a stored capture on demand
 * — the corner editor's "Detect corners" button. Returns the detected corners, or `null`
 * when it can't separate the sleeve from the background (the caller leaves the handles put).
 */
export async function detectCaptureCorners(
	capturePhotoKey: string,
): Promise<NormalizedCorners | null> {
	return detectSleeveCorners(await loadCapture(capturePhotoKey));
}

/**
 * Reframe a record end-to-end for the queue (auto-on-capture + bulk). Decodes the capture
 * once, then picks the corner band: the admin's stored band if there is one (legacy
 * single-quad rows are synthesised into a band at parse time), otherwise a band seeded
 * from a best-effort {@link detectSleeveCorners} pass (full-frame default when detection
 * can't find the sleeve). Returns the new professional R2 key AND the band used, so the
 * consumer can persist it — that seed is what the corner editor opens pre-cropped to.
 * Does NOT touch the DB itself.
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
	const capture = await loadCapture(record.capturePhotoKey);
	// Respect a stored band; otherwise seed by detecting the sleeve (full-frame fallback).
	let band: CornerBand;
	if (record.sleeveCornersJson) {
		band = parseCornerBand(record.sleeveCornersJson);
	} else {
		const detected = detectSleeveCorners(capture);
		band = detected ? bandFromQuad(detected) : DEFAULT_BAND;
	}
	const { key: professionalKey } = await warpEncodeStore(
		capture,
		band,
		parseReframeParams(record.professionalParamsJson),
	);
	return { professionalKey, band };
}
