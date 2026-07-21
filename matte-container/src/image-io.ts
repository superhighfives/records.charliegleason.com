/**
 * The container's image-IO shims — the small binding-coupled surface that `src/lib/matte.ts`
 * gets from Photon + the Cloudflare Images binding, reimplemented on sharp (libvips). Same
 * signatures and semantics as `src/lib/professional.ts`'s `decodeRgba` / `encodePng` /
 * `upscaleImage` (plus a WebP encoder), so the reused pixel math sees identical inputs — but
 * off the JS heap and out of the 128MB isolate, which is the whole point of the container.
 *
 * NOTE: the ESRGAN constants below mirror `src/lib/professional.ts`. Keep them in sync (the
 * version is a pinned hash that rarely changes).
 */

import sharp from "sharp";

import type { RgbaImage } from "#/lib/photo-processing";

const REAL_ESRGAN_VERSION =
	"b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8";
const UPSCALE_INPUT_MAX = 1400;
const UPSCALE_FACTOR = 4;
const UPSCALE_MAX = 4000;

import { firstOutputUrl, runVersion } from "./replicate.ts";

/** A sharp instance over an in-memory RGBA image (raw, 4 channels). */
function fromRgba(image: RgbaImage) {
	return sharp(
		Buffer.from(
			image.data.buffer,
			image.data.byteOffset,
			image.data.byteLength,
		),
		{ raw: { width: image.width, height: image.height, channels: 4 } },
	);
}

/** Decode encoded image bytes (jpeg/webp/png/…) to an {@link RgbaImage}. */
export async function decodeRgba(bytes: Uint8Array): Promise<RgbaImage> {
	const { data, info } = await sharp(bytes)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	// View over sharp's owned buffer (no copy) — matches the RgbaImage contract.
	return {
		data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
	};
}

/** Encode an {@link RgbaImage} to PNG bytes (preserves alpha). */
export function encodePng(image: RgbaImage): Promise<Buffer> {
	return fromRgba(image).png({ compressionLevel: 6 }).toBuffer();
}

/**
 * Canonicalise an {@link RgbaImage} to a webp-with-alpha. Mirrors the Worker's `encodeWebp`:
 * a straight encode (no sharpen, which would harden the soft feather/shadow), alpha kept.
 */
export function encodeWebp(image: RgbaImage): Promise<Buffer> {
	return fromRgba(image).webp({ quality: 92, alphaQuality: 100 }).toBuffer();
}

/**
 * Super-resolve an opaque RGBA image through Real-ESRGAN — the container's version of
 * `professional.ts#upscaleImage`. Downscales under the model's input-pixel ceiling, ships it
 * as a data URI, and returns the (larger) output decoded back to RGBA, capped at `maxSize`.
 * ESRGAN drops alpha, so callers re-attach their own.
 */
export async function upscaleImage(
	img: RgbaImage,
	replicateToken: string,
	opts: { maxSize?: number } = {},
): Promise<RgbaImage> {
	const cap = opts.maxSize ?? UPSCALE_MAX;
	const fitted = await fromRgba(img)
		.resize({
			width: UPSCALE_INPUT_MAX,
			height: UPSCALE_INPUT_MAX,
			fit: "inside",
			withoutEnlargement: true,
		})
		.webp({ quality: 92 })
		.toBuffer();
	const dataUri = `data:image/webp;base64,${fitted.toString("base64")}`;

	const prediction = await runVersion(replicateToken, REAL_ESRGAN_VERSION, {
		image: dataUri,
		scale: UPSCALE_FACTOR,
		face_enhance: false,
	});
	const url = firstOutputUrl(prediction.output);
	if (!url) throw new Error("Replicate returned no upscaled image");

	const res = await fetch(url);
	if (!res.ok)
		throw new Error(`fetching the upscaled image failed (${res.status})`);
	const out = await sharp(Buffer.from(await res.arrayBuffer()))
		.resize({
			width: cap,
			height: cap,
			fit: "inside",
			withoutEnlargement: true,
		})
		.toBuffer();
	return decodeRgba(out);
}
