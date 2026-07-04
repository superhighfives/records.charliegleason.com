import { getReleaseImageUrl } from "#/lib/discogs";

/**
 * Build the HTTP response that proxies a Discogs release's full-res primary cover.
 *
 * Split out from the route so it can be unit-tested without a Workers runtime:
 * the two network steps (resolve the image URL via the Discogs API, then stream
 * the image bytes) are both mockable here. See src/routes/api/discogs-cover.$id.ts.
 */

const UA = "RecordsCharlieGleasonCom/1.0 +https://records.charliegleason.com";

export async function discogsCoverResponse(id: string): Promise<Response> {
	if (!/^\d+$/.test(id)) {
		return new Response("Bad release id", { status: 400 });
	}

	const url = await getReleaseImageUrl(id).catch(() => null);
	if (!url) {
		return new Response("No cover for this release", { status: 404 });
	}

	const upstream = await fetch(url, { headers: { "User-Agent": UA } });
	if (!upstream.ok || !upstream.body) {
		return new Response("Upstream image fetch failed", { status: 502 });
	}

	return new Response(upstream.body, {
		headers: {
			"content-type": upstream.headers.get("content-type") ?? "image/jpeg",
			// Short cache — a release's cover is stable, but keep it modest so a
			// re-uploaded image on Discogs surfaces without a long stale window.
			"cache-control": "public, max-age=3600",
		},
	});
}
