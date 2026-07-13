import { env } from "cloudflare:workers";
import { PhotonImage } from "@cf-wasm/photon";

import type { Record } from "#/db/schema";
import { bytesToBase64 } from "#/lib/image-data";
import {
	applyMaskAlpha,
	type RgbaImage,
	reframeSquare,
} from "#/lib/photo-processing";
import {
	DEFAULT_REFRAME_PARAMS,
	parseReframeParams,
	type ReframeParams,
} from "#/lib/reframe-params";
import { firstOutputUrl, runVersion } from "#/lib/replicate";

/**
 * Turn a rough iPhone capture into a clean, straight-on studio shot of the physical
 * sleeve — by *processing* the real photo, never repainting it.
 *
 * The old pipeline sent the capture through a generative image editor (FLUX.2) to
 * "restyle" it, which inevitably took creative liberties: it redrew artwork, smoothed
 * halftones and flattened paper texture. Crop, square and lighting are all
 * deterministic operations, so we do them deterministically instead:
 *
 *   1. Segment the sleeve by prompting grounded_sam with the *physical object* (not
 *      a plain background-remover, which grabs the subject depicted in the artwork),
 *      then composite that mask onto the original capture → a straight-alpha cutout
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

// Sleeve segmentation. Plain background-removal models find the salient subject
// *depicted in the album art* (a face, a figure) and cut everything else away — the
// opposite of what we want. So instead we prompt schananas/grounded_sam (Grounding
// DINO + SAM) with the PHYSICAL object, so it segments the whole rectangular sleeve
// regardless of what the cover depicts. Community model → pinned version, run via
// `runVersion`. Returns a white-on-black mask we composite onto the real capture.
const SLEEVE_SEGMENT_VERSION =
	"ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c";
const SLEEVE_MASK_PROMPT = "album cover, record sleeve";

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
 * Step 1 — the PAID segmentation. Prompts grounded_sam with the physical sleeve so it
 * returns a mask of the whole rectangle (not the artwork's subject), composites that
 * mask onto the ORIGINAL capture to make a straight-alpha cutout (real RGB, alpha =
 * sleeve), and stores it under `cutout/` in R2. Persisted so {@link reframeFromCutout}
 * can be re-run for free afterwards — the only Replicate call in the pipeline. Returns
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

	// Segment the sleeve rectangle by prompting for the physical object.
	const seg = await runVersion(SLEEVE_SEGMENT_VERSION, {
		image: captureDataUri,
		mask_prompt: SLEEVE_MASK_PROMPT,
		negative_mask_prompt: "",
		adjustment_factor: 0,
	});
	const maskUrl = firstOutputUrl(seg.output);
	if (!maskUrl) throw new Error("sleeve segmentation returned no mask");

	const maskRes = await fetch(maskUrl);
	if (!maskRes.ok) throw new Error(`mask fetch failed (${maskRes.status})`);
	const maskRgba = decodeRgba(new Uint8Array(await maskRes.arrayBuffer()));

	// Composite the mask onto the real capture → straight-alpha cutout. The RGB stays
	// the untouched photo; the alpha now marks the sleeve, so the reframe's corner
	// detection sees the rectangle instead of whatever the cover depicts.
	const cutout = applyMaskAlpha(decodeRgba(bytes), maskRgba);

	const key = `cutout/${crypto.randomUUID()}.png`;
	await env.PHOTOS.put(key, encodePng(cutout), {
		httpMetadata: { contentType: "image/png" },
	});

	return { key, predictionId: seg.id };
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

/**
 * Both steps end-to-end: run the paid matte, then an initial reframe with whatever
 * knobs are remembered on the row. Returns the new R2 keys and prediction id for the
 * caller to persist. Shared by the queue consumer (auto-on-capture + bulk) and the
 * interactive server fn, so the two stay in lockstep. Does NOT touch the DB itself.
 */
export async function mattePipeline(
	record: Pick<Record, "capturePhotoKey" | "professionalParamsJson">,
): Promise<{
	cutoutKey: string;
	professionalKey: string;
	predictionId: string;
}> {
	if (!record.capturePhotoKey) {
		throw new Error("record has no capture photo to work from");
	}
	const { key: cutoutKey, predictionId } = await generateCutout(
		record.capturePhotoKey,
	);
	const { key: professionalKey } = await reframeFromCutout(
		cutoutKey,
		parseReframeParams(record.professionalParamsJson),
	);
	return { cutoutKey, professionalKey, predictionId };
}
