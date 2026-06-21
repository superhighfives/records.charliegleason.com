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
