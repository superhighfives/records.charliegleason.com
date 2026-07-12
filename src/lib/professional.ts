import { env } from "cloudflare:workers";
import { PhotonImage } from "@cf-wasm/photon";

import type { Record } from "#/db/schema";
import { bytesToBase64 } from "#/lib/image-data";
import { type RgbaImage, reframeSquare } from "#/lib/photo-processing";
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
 * webp-with-alpha (like the cover pipeline) before storing under `professional/` in
 * R2. Only one Replicate pass now (the matte), so it's cheaper and faster too.
 *
 * Returns the R2 key plus the Replicate prediction id (kept on the row for
 * debugging). Throws on any failure — the queue consumer records it on the row.
 * Server-only (pulls in `cloudflare:workers`); never import from a client route.
 */

// Background matting → transparent cutout. An official model, run at its latest
// version (see `runModel` — only official models work there).
const CUTOUT_MODEL = "bria/remove-background";

// Final framing — always a square canvas. The warped sleeve fills a CONTENT_SIZE
// square, then is padded out to a CANVAS_SIZE square; the even gap is the
// transparent margin on each side (here (2000-1920)/2 = 40px, 2%).
const CANVAS_SIZE = 2000;
const CONTENT_SIZE = 1920;

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

export interface ProfessionalResult {
	key: string;
	predictionId: string;
}

export async function generateProfessionalPhoto(
	record: Record,
): Promise<ProfessionalResult> {
	if (!record.capturePhotoKey) {
		throw new Error("record has no capture photo to work from");
	}

	const object = await env.PHOTOS.get(record.capturePhotoKey);
	if (!object) {
		throw new Error(`capture photo missing in R2: ${record.capturePhotoKey}`);
	}
	const bytes = new Uint8Array(await object.arrayBuffer());
	const mediaType = object.httpMetadata?.contentType || "image/webp";
	const captureDataUri = `data:${mediaType};base64,${bytesToBase64(bytes)}`;

	// 1. Background matte on the ORIGINAL capture → straight-alpha cutout. The RGB is
	// the untouched photo; the alpha marks the sleeve (used to find its corners).
	const cutout = await runModel(CUTOUT_MODEL, { image: captureDataUri });
	const cutoutUrl = firstOutputUrl(cutout.output);
	if (!cutoutUrl) throw new Error("background removal returned no image");

	const cutoutRes = await fetch(cutoutUrl);
	if (!cutoutRes.ok) {
		throw new Error(`cutout fetch failed (${cutoutRes.status})`);
	}
	const cutoutRgba = decodeRgba(new Uint8Array(await cutoutRes.arrayBuffer()));

	// 2. + 3. Deterministic reframe: detect the sleeve, perspective-warp to a square
	// (or bbox-crop as a fallback), pad to the canvas, and auto-tone. Real pixels
	// throughout — nothing is regenerated.
	const { image } = reframeSquare(cutoutRgba, {
		canvasSize: CANVAS_SIZE,
		contentSize: CONTENT_SIZE,
	});

	// 4. Canonicalise to a webp-with-alpha via the Images binding (mirrors the cover
	// pipeline; webp keeps the transparency), with a gentle sharpen to counter the
	// warp's bilinear softening, then store in R2.
	const png = encodePng(image);
	const out = await env.IMAGES.input(blobStream(png))
		.transform({ sharpen: FINAL_SHARPEN })
		.output({ format: "image/webp", quality: 92 });
	const buffer = await out.response().arrayBuffer();

	const key = `professional/${crypto.randomUUID()}.webp`;
	await env.PHOTOS.put(key, buffer, {
		httpMetadata: { contentType: "image/webp" },
	});

	return { key, predictionId: cutout.id };
}
