import { env } from "cloudflare:workers";
import { PhotonImage } from "@cf-wasm/photon";

import { bytesToBase64 } from "#/lib/image-data";
import { type RgbaImage, reframeSquare } from "#/lib/photo-processing";
import {
	DEFAULT_REFRAME_PARAMS,
	type ReframeParams,
} from "#/lib/reframe-params";
import { firstOutputUrl, runModel } from "#/lib/replicate";

/**
 * Turn a rough iPhone capture into a clean, straight-on studio shot of the physical
 * sleeve — by *processing* the real photo, never repainting it.
 *
 * The old pipeline sent the capture through a generative image editor (FLUX.2) to
 * "restyle" it, which inevitably took creative liberties: it redrew artwork, smoothed
 * halftones and flattened paper texture. Crop, square and lighting are all
 * deterministic operations, so we do them deterministically instead:
 *
 *   1. Background matting (Bria) on the *original capture* → a straight-alpha cutout
 *      whose RGB is the real photo and whose alpha marks the sleeve.
 *   2. From that alpha we find the sleeve's four corners and perspective-warp the
 *      real pixels onto a square — cropping, squaring and de-keystoning in one step
 *      (a classic "document scanner" homography). If the quad looks unreliable we
 *      fall back to a plain bounding-box crop (no perspective).
 *   3. Foreground-aware auto-levels + grey-world white balance normalise exposure
 *      and neutralise the ambient colour cast, so every shot looks consistent.
 *
 * The pixel math lives in {@link reframeSquare} (pure, unit-tested); Photon decodes
 * the cutout and re-encodes the result, and the Images binding canonicalises to a
 * webp-with-alpha (like the cover pipeline) before storing under `professional/`.
 *
 * The work is split into two functions so the paid part happens once: the matte
 * ({@link generateCutout}, the only Replicate call) is run and stored once, then the
 * deterministic reframe ({@link reframeFromCutout}) can be re-run for free with
 * different {@link ReframeParams} knobs as often as the admin likes.
 *
 * Server-only (pulls in `cloudflare:workers`); never import from a client route —
 * the shared knob type/defaults live in `reframe-params.ts` for that.
 */

// Background matting → transparent cutout. An official model, run at its latest
// version (see `runModel` — only official models work there).
const CUTOUT_MODEL = "bria/remove-background";

// Final framing — always a square canvas. The warped sleeve fills a content square,
// then is padded out to a CANVAS_SIZE square; the even gap is the transparent margin
// on each side, sized by `marginPct` (2% → (2000-1920)/2 = 40px each side).
const CANVAS_SIZE = 2000;

// Sharpen strength for the final Images pass. Gentle — just enough to counter the
// bilinear softening from the warp, not enough to crunch the halftone.
const FINAL_SHARPEN = 1.0;

/** A fresh single-use stream over the same bytes (the Images binding consumes one per call). */
function blobStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([bytes as BlobPart]).stream();
}

/** Decode encoded image bytes to an {@link RgbaImage} via Photon. */
function decodeRgba(bytes: Uint8Array): RgbaImage {
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
function encodePng(image: RgbaImage): Uint8Array {
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

/**
 * Step 1 — the PAID matte. Runs Bria background removal on the original capture and
 * stores the resulting straight-alpha cutout (raw PNG, RGB untouched, alpha marking
 * the sleeve) under `cutout/` in R2. Persisted so {@link reframeFromCutout} can be
 * re-run for free afterwards — the only Replicate call in the whole pipeline. Returns
 * the cutout's R2 key and the prediction id (kept on the row for debugging).
 */
export async function generateCutout(
	capturePhotoKey: string,
): Promise<{ key: string; predictionId: string }> {
	const object = await env.PHOTOS.get(capturePhotoKey);
	if (!object) {
		throw new Error(`capture photo missing in R2: ${capturePhotoKey}`);
	}
	const bytes = new Uint8Array(await object.arrayBuffer());
	const mediaType = object.httpMetadata?.contentType || "image/webp";
	const captureDataUri = `data:${mediaType};base64,${bytesToBase64(bytes)}`;

	const cutout = await runModel(CUTOUT_MODEL, { image: captureDataUri });
	const cutoutUrl = firstOutputUrl(cutout.output);
	if (!cutoutUrl) throw new Error("background removal returned no image");

	const cutoutRes = await fetch(cutoutUrl);
	if (!cutoutRes.ok) {
		throw new Error(`cutout fetch failed (${cutoutRes.status})`);
	}
	const cutoutBytes = new Uint8Array(await cutoutRes.arrayBuffer());

	// Store the matte verbatim (Bria hands back a straight-alpha PNG). Photon sniffs
	// the format from the bytes on decode, so the extension is only cosmetic.
	const key = `cutout/${crypto.randomUUID()}.png`;
	await env.PHOTOS.put(key, cutoutBytes, {
		httpMetadata: { contentType: "image/png" },
	});

	return { key, predictionId: cutout.id };
}

/**
 * Step 2 — the FREE reframe. Reads a stored cutout, deterministically detects the
 * sleeve, perspective-warps it to a square (or bbox-crops as a fallback), pads to the
 * canvas, and auto-tones — all real pixels, nothing regenerated. Re-runnable with
 * different {@link ReframeParams} as often as the admin likes without another paid
 * matte. Canonicalises to a webp-with-alpha via the Images binding (like the cover
 * pipeline) and stores it under `professional/`. Returns the new R2 key.
 */
export async function reframeFromCutout(
	cutoutKey: string,
	params: ReframeParams = {},
): Promise<{ key: string }> {
	const object = await env.PHOTOS.get(cutoutKey);
	if (!object) throw new Error(`cutout missing in R2: ${cutoutKey}`);
	const cutoutRgba = decodeRgba(new Uint8Array(await object.arrayBuffer()));

	const p = { ...DEFAULT_REFRAME_PARAMS, ...params };
	// Margin is a % of the canvas on each side; the sleeve fills what's left.
	const contentSize = Math.round(CANVAS_SIZE * (1 - (2 * p.marginPct) / 100));
	const { image } = reframeSquare(cutoutRgba, {
		canvasSize: CANVAS_SIZE,
		contentSize,
		// `skipTone` keeps the warped capture at its original exposure; otherwise the
		// white-balance/levels knobs feed auto-tone.
		tone: p.skipTone
			? false
			: { wbStrength: p.wbStrength, lowPct: p.lowPct, highPct: p.highPct },
	});

	const png = encodePng(image);
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
