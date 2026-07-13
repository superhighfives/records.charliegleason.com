import { env } from "cloudflare:workers";
import { PhotonImage } from "@cf-wasm/photon";

import type { Record } from "#/db/schema";
import {
	type Corners,
	type RgbaImage,
	reframeFromCorners,
} from "#/lib/photo-processing";
import {
	DEFAULT_REFRAME_PARAMS,
	parseReframeParams,
	type ReframeParams,
} from "#/lib/reframe-params";
import {
	DEFAULT_CORNERS,
	type NormalizedCorners,
	parseCorners,
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
 * admin corner editor (optionally seeded by an in-browser OpenCV document-scan), stored
 * on the row as {@link NormalizedCorners}. Given those corners this module:
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
 * There is no paid step anymore: the whole reframe is free and deterministic, so it
 * re-runs on demand whenever the admin nudges the corners or the {@link ReframeParams}
 * tone/margin knobs.
 *
 * Server-only (pulls in `cloudflare:workers`); never import from a client route — the
 * shared knob/corner types + defaults live in `reframe-params.ts` / `sleeve-corners.ts`.
 */

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

/** Scale normalised (0..1) corners up to pixel coordinates for a `w`×`h` capture. */
function toPixelCorners(
	corners: NormalizedCorners,
	w: number,
	h: number,
): Corners {
	return corners.map(([x, y]) => [x * (w - 1), y * (h - 1)]) as Corners;
}

/**
 * The whole (free, deterministic) reframe: read the capture from R2, warp it to a
 * square using the sleeve's `corners`, pad to the canvas, auto-tone, canonicalise to a
 * webp-with-alpha via the Images binding, and store it under `professional/`. Re-runnable
 * as often as the admin likes — with new corners or new {@link ReframeParams} — at no
 * cost, since nothing is regenerated and there's no external call. Returns the new R2 key.
 */
export async function reframeFromCapture(
	capturePhotoKey: string,
	corners: NormalizedCorners,
	params: ReframeParams = {},
): Promise<{ key: string }> {
	const object = await env.PHOTOS.get(capturePhotoKey);
	if (!object)
		throw new Error(`capture photo missing in R2: ${capturePhotoKey}`);
	const capture = decodeRgba(new Uint8Array(await object.arrayBuffer()));

	const p = { ...DEFAULT_REFRAME_PARAMS, ...params };
	// Margin is a % of the canvas on each side; the sleeve fills what's left.
	const contentSize = Math.round(CANVAS_SIZE * (1 - (2 * p.marginPct) / 100));
	const { image } = reframeFromCorners(
		capture,
		toPixelCorners(corners, capture.width, capture.height),
		{
			canvasSize: CANVAS_SIZE,
			contentSize,
			// `skipTone` keeps the warped capture at its original exposure; otherwise the
			// white-balance/levels knobs feed auto-tone.
			tone: p.skipTone
				? false
				: { wbStrength: p.wbStrength, lowPct: p.lowPct, highPct: p.highPct },
		},
	);

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
 * Reframe a record end-to-end using whatever corners + knobs are remembered on the row
 * (falling back to the full-frame default corners for a fresh capture). Shared by the
 * queue consumer (auto-on-capture + bulk) and the interactive server fn so the two stay
 * in lockstep. Does NOT touch the DB itself — returns the new professional R2 key for
 * the caller to persist.
 */
export async function professionalPipeline(
	record: Pick<
		Record,
		"capturePhotoKey" | "sleeveCornersJson" | "professionalParamsJson"
	>,
): Promise<{ professionalKey: string }> {
	if (!record.capturePhotoKey) {
		throw new Error("record has no capture photo to work from");
	}
	const corners = record.sleeveCornersJson
		? parseCorners(record.sleeveCornersJson)
		: DEFAULT_CORNERS;
	const { key: professionalKey } = await reframeFromCapture(
		record.capturePhotoKey,
		corners,
		parseReframeParams(record.professionalParamsJson),
	);
	return { professionalKey };
}
