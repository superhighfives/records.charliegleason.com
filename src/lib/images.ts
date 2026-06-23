import { env } from "cloudflare:workers";

import { getReleaseImageUrl } from "#/lib/discogs";

/**
 * Source a good-quality cover and store a resized copy in R2.
 *
 * The iPhone capture is kept as a reference (admin only); the *displayed* cover
 * comes from Discogs, resized to a sane size with the Cloudflare Images binding
 * (webp, max 600px). Returns the R2 key, or null on any failure (the record just
 * shows no cover then). Requires Image Transformations enabled on the account.
 */

const UA = "RecordsCharlieGleasonCom/1.0 +https://records.charliegleason.com";

export async function storeResizedCover(
	imageUrl: string,
): Promise<string | null> {
	try {
		const res = await fetch(imageUrl, { headers: { "User-Agent": UA } });
		if (!res.ok || !res.body) return null;

		const out = await env.IMAGES.input(res.body)
			.transform({ width: 600, height: 600, fit: "scale-down" })
			.output({ format: "image/webp", quality: 82 });
		const bytes = await out.response().arrayBuffer();

		const key = `covers/${crypto.randomUUID()}.webp`;
		await env.PHOTOS.put(key, bytes, {
			httpMetadata: { contentType: "image/webp" },
		});
		return key;
	} catch {
		return null;
	}
}

export async function sourceCoverFromDiscogs(
	discogsId: string,
): Promise<string | null> {
	const url = await getReleaseImageUrl(discogsId).catch(() => null);
	return url ? storeResizedCover(url) : null;
}

/**
 * Normalise an uploaded capture and store it in R2. The browser already crops to
 * a square and shrinks for a fast upload; Cloudflare Images then canonicalises it
 * to a square webp (consistent format/size, EXIF stripped) and guarantees the
 * square even if the client fell back to uploading the original.
 *
 * The capture is what the vision step reads, so this must always store *something*
 * — if Image Transformations are unavailable it falls back to the raw bytes.
 * Returns the R2 key plus the stored content type (used as the vision media type).
 */
export async function storeCapturePhoto(
	bytes: Uint8Array,
	fallbackMediaType: string,
): Promise<{ key: string; contentType: string }> {
	try {
		const out = await env.IMAGES.input(new Blob([bytes as BlobPart]).stream())
			.transform({ width: 1280, height: 1280, fit: "cover" })
			.output({ format: "image/webp", quality: 82 });
		const buffer = await out.response().arrayBuffer();
		const key = `captures/${crypto.randomUUID()}.webp`;
		await env.PHOTOS.put(key, buffer, {
			httpMetadata: { contentType: "image/webp" },
		});
		return { key, contentType: "image/webp" };
	} catch {
		const ext =
			fallbackMediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
		const key = `captures/${crypto.randomUUID()}.${ext}`;
		await env.PHOTOS.put(key, bytes, {
			httpMetadata: { contentType: fallbackMediaType },
		});
		return { key, contentType: fallbackMediaType };
	}
}
