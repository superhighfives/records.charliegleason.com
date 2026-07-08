/**
 * Browser-only image prep for the capture flow. Album sleeves are square, so we
 * center-crop the photo to a square and downscale it before upload — a 4–8 MB
 * iPhone HEIC/JPEG becomes a ~150–300 KB JPEG, which is the difference between a
 * slow upload on cellular and a near-instant one. The server still runs the
 * result through Cloudflare Images to canonicalise it (square webp).
 *
 * Anything in here touches `document`/`canvas`, so it must only be called from
 * the browser (event handlers), never at module top level or during SSR.
 */

// Big enough to feed the professional-photo pipeline's 4 MP restyle a clean,
// detailed source — and for Claude to read the cover — while still shrinking a
// 4–8 MB iPhone HEIC to a quick sub-MB upload. Raised from 1280/0.85: the studio
// editor preserves the detail it's given, so a sharper capture carries through to
// a sharper final photo.
const TARGET_SIZE = 2048;
const QUALITY = 0.92;

export type ProcessedImage = { dataUrl: string; mediaType: string };

/** Decode a file to something drawable, respecting EXIF orientation. */
async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
	// createImageBitmap is fastest and can bake in EXIF orientation, but doesn't
	// decode HEIC everywhere — fall back to an <img>, which the browser orients
	// for us on draw.
	try {
		return await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		const url = URL.createObjectURL(file);
		try {
			const img = new Image();
			img.decoding = "async";
			img.src = url;
			await img.decode();
			return img;
		} finally {
			URL.revokeObjectURL(url);
		}
	}
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/**
 * Center-crop `file` to a square and downscale it to a JPEG data URL. Throws if
 * the browser can't decode the image (HEIC on a desktop browser, say) — callers
 * should fall back to uploading the original file in that case.
 */
export async function squareDownscale(file: File): Promise<ProcessedImage> {
	const source = await loadImage(file);
	const width = source.width;
	const height = source.height;
	const side = Math.min(width, height);
	const target = Math.min(side, TARGET_SIZE);

	const canvas = document.createElement("canvas");
	canvas.width = target;
	canvas.height = target;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas 2d context unavailable");

	// Draw the centered square region scaled to the target size.
	ctx.drawImage(
		source,
		(width - side) / 2,
		(height - side) / 2,
		side,
		side,
		0,
		0,
		target,
		target,
	);
	if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
		source.close();
	}

	const blob = await toBlob(canvas, "image/jpeg");
	if (!blob) throw new Error("canvas toBlob failed");
	return { dataUrl: await blobToDataUrl(blob), mediaType: "image/jpeg" };
}
