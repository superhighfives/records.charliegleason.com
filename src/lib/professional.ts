import { env } from "cloudflare:workers";

import type { Record } from "#/db/schema";
import { bytesToBase64 } from "#/lib/image-data";
import { firstOutputUrl, runModel } from "#/lib/replicate";

/**
 * Turn a rough iPhone capture into a studio product shot of the physical sleeve.
 *
 * Two Replicate passes: an instruction-based editor restyles the photo as a
 * straight-on, evenly-lit studio shot on a plain seamless background (it's
 * identity-preserving, so it keeps the actual artwork rather than inventing new
 * art), then a background-matting model cuts the background out to transparency
 * for a true "zero background" cutout. The result is canonicalised to a
 * webp-with-alpha via the Cloudflare Images binding (like the cover pipeline) and
 * stored under `professional/` in R2.
 *
 * Returns the R2 key plus the Replicate prediction id (kept on the row for
 * debugging). Throws on any failure — the queue consumer records it on the row.
 * Server-only (pulls in `cloudflare:workers`); never import from a client route.
 */

// Instruction-based editor. Identity-preserving, so the sleeve's artwork/text is
// kept while lighting, angle and background are cleaned up. Swap the model here
// for higher fidelity, in this one place.
const KONTEXT_MODEL = "black-forest-labs/flux-kontext-pro";
// Background matting → transparent cutout ("zero background"). An official model,
// run at its latest version (see `runModel` — only official models work there).
const CUTOUT_MODEL = "bria/remove-background";

// Final framing — always a square canvas. The trimmed sleeve is fit into a
// CONTENT_SIZE square, then padded out to a CANVAS_SIZE square; the even gap is the
// transparent margin on each side (here (1000-960)/2 = 20px, 2%). Shrink
// CONTENT_SIZE for more breathing room.
const CANVAS_SIZE = 1000;
const CONTENT_SIZE = 960;

const STUDIO_PROMPT =
	"Restyle this photograph of a vinyl record sleeve as a high-end studio product " +
	"shot: a straight-on, front-facing view of the sleeve, tightly cropped to its " +
	"edges, lit with soft even diffused studio lighting and no harsh shadows or " +
	"glare, on a plain seamless light-grey background. Keep the sleeve's artwork, " +
	"text, logos and colours exactly as they are — do not alter, add, or remove any " +
	"part of the artwork.";

/** Fetch an image URL and inline it as a data URI (Replicate image inputs accept both). */
async function fetchAsDataUri(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`fetch output failed (${res.status}) for ${url}`);
	}
	const type = res.headers.get("content-type") || "image/png";
	const bytes = new Uint8Array(await res.arrayBuffer());
	return `data:${type};base64,${bytesToBase64(bytes)}`;
}

/** A fresh single-use stream over the same bytes (the Images binding consumes one per call). */
function blobStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([bytes as BlobPart]).stream();
}

// Resolution of the proxy we scan for the artwork's bounding box. A small fixed
// square keeps the alpha scan cheap; per-axis fractions map back to the original
// exactly despite the squeeze distortion.
const SCAN_SIZE = 400;
// Ignore the anti-aliased fringe when deciding what counts as "the artwork".
const ALPHA_MIN = 16;

type Insets = { top: number; right: number; bottom: number; left: number };

/**
 * Pixels to trim off each side of the cutout to reach the artwork's bounding box.
 *
 * The background-removal model returns *straight* alpha — transparent pixels keep
 * their original background RGB — so Cloudflare's colour-based `trim: "border"`
 * sees no uniform border and trims nothing. Instead we read the alpha channel off a
 * small proxy and find the box ourselves.
 *
 * Returns `null` when the raw `rgba` decode isn't available — notably `wrangler dev`,
 * where it errors with `IMAGES_TRANSFORM_ERROR 9520` — so the caller can fall back to
 * an untrimmed reframe. The real (deployed) Images binding always resolves.
 */
async function contentInsets(
	bytes: Uint8Array,
	width: number,
	height: number,
): Promise<Insets | null> {
	let rgba: Uint8Array;
	try {
		const scan = await env.IMAGES.input(blobStream(bytes))
			.transform({ width: SCAN_SIZE, height: SCAN_SIZE, fit: "squeeze" })
			.output({ format: "rgba" });
		rgba = new Uint8Array(await scan.response().arrayBuffer());
	} catch {
		return null;
	}

	let minX = SCAN_SIZE;
	let minY = SCAN_SIZE;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < SCAN_SIZE; y++) {
		for (let x = 0; x < SCAN_SIZE; x++) {
			if (rgba[(y * SCAN_SIZE + x) * 4 + 3] >= ALPHA_MIN) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}

	// Fully transparent (shouldn't happen) — treat as nothing to trim.
	if (maxX < minX || maxY < minY)
		return { top: 0, right: 0, bottom: 0, left: 0 };

	return {
		left: Math.round((minX / SCAN_SIZE) * width),
		right: width - Math.round(((maxX + 1) / SCAN_SIZE) * width),
		top: Math.round((minY / SCAN_SIZE) * height),
		bottom: height - Math.round(((maxY + 1) / SCAN_SIZE) * height),
	};
}

/**
 * Reframe the transparent cutout so the artwork fills the frame with a small, even
 * margin, and canonicalise to a webp-with-alpha for R2: crop to the artwork's
 * bounding box (see `contentInsets`), scale into a CONTENT_SIZE square, then pad back
 * out to the CANVAS_SIZE canvas. When the bounding box can't be measured (local dev),
 * skip the crop — the image is still square and valid, just with the model's original
 * margin.
 */
async function reframeCutout(bytes: Uint8Array): Promise<ArrayBuffer> {
	const info = await env.IMAGES.info(blobStream(bytes));
	if (!("width" in info)) throw new Error("cutout has no raster dimensions");

	const trim =
		(await contentInsets(bytes, info.width, info.height)) ??
		({ top: 0, right: 0, bottom: 0, left: 0 } satisfies Insets);

	const out = await env.IMAGES.input(blobStream(bytes))
		.transform({ trim })
		.transform({ width: CONTENT_SIZE, height: CONTENT_SIZE, fit: "contain" })
		.transform({
			width: CANVAS_SIZE,
			height: CANVAS_SIZE,
			fit: "pad",
			background: "rgba(0,0,0,0)",
		})
		.output({ format: "image/webp", quality: 90 });
	return out.response().arrayBuffer();
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

	// 1. Studio restyle — keeps the artwork, fixes lighting/angle.
	const studio = await runModel(KONTEXT_MODEL, {
		prompt: STUDIO_PROMPT,
		input_image: captureDataUri,
		output_format: "png",
		aspect_ratio: "match_input_image",
	});
	const studioUrl = firstOutputUrl(studio.output);
	if (!studioUrl) throw new Error("studio restyle returned no image");

	// 2. Background cutout → transparent PNG.
	const cutout = await runModel(CUTOUT_MODEL, {
		image: await fetchAsDataUri(studioUrl),
	});
	const cutoutUrl = firstOutputUrl(cutout.output);
	if (!cutoutUrl) throw new Error("background removal returned no image");

	// 3. Reframe the cutout to an even margin and canonicalise to a webp-with-alpha
	// (mirrors the cover pipeline; webp keeps the transparency), then store in R2.
	const finalRes = await fetch(cutoutUrl);
	if (!finalRes.ok) {
		throw new Error(`cutout fetch failed (${finalRes.status})`);
	}
	const buffer = await reframeCutout(
		new Uint8Array(await finalRes.arrayBuffer()),
	);

	const key = `professional/${crypto.randomUUID()}.webp`;
	await env.PHOTOS.put(key, buffer, {
		httpMetadata: { contentType: "image/webp" },
	});

	return { key, predictionId: studio.id };
}
