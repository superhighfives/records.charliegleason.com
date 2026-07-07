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

	// 3. Canonicalise to a webp-with-alpha and store in R2 (mirrors the cover
	// pipeline; webp keeps the transparency from the cutout). The cutout arrives
	// with a wide, uneven transparent margin, so reframe it: `trim: "border"`
	// crops the transparent surround down to the artwork's bounding box, then we
	// fit that into a slightly smaller square and pad back out to the full canvas
	// with a transparent background — leaving a small, even margin so the edge
	// isn't flush against the frame.
	const finalRes = await fetch(cutoutUrl);
	if (!finalRes.ok || !finalRes.body) {
		throw new Error(`cutout fetch failed (${finalRes.status})`);
	}
	const out = await env.IMAGES.input(finalRes.body)
		.transform({ trim: "border" })
		.transform({ width: CONTENT_SIZE, height: CONTENT_SIZE, fit: "contain" })
		.transform({
			width: CANVAS_SIZE,
			height: CANVAS_SIZE,
			fit: "pad",
			background: "rgba(0,0,0,0)",
		})
		.output({ format: "image/webp", quality: 90 });
	const buffer = await out.response().arrayBuffer();

	const key = `professional/${crypto.randomUUID()}.webp`;
	await env.PHOTOS.put(key, buffer, {
		httpMetadata: { contentType: "image/webp" },
	});

	return { key, predictionId: studio.id };
}
