import { getReleaseImageUrl } from "#/lib/discogs";

/**
 * Build the HTTP response that proxies a Discogs release's full-res primary cover.
 *
 * Split out from the route so it can be unit-tested without a Workers runtime:
 * the two network steps (resolve the image URL via the Discogs API, then stream
 * the image bytes) are both mockable here. See src/routes/api/discogs-cover.$id.ts.
 */

const UA = "RecordsCharlieGleasonCom/1.0 +https://records.charliegleason.com";

/** Discogs serves cover art from its own domain (i.discogs.com, img.discogs.com…). */
function isDiscogsImageUrl(url: string): boolean {
	try {
		const { protocol, hostname } = new URL(url);
		return (
			protocol === "https:" &&
			(hostname === "discogs.com" || hostname.endsWith(".discogs.com"))
		);
	} catch {
		return false;
	}
}

export async function discogsCoverResponse(id: string): Promise<Response> {
	if (!/^\d+$/.test(id)) {
		return new Response("Bad release id", { status: 400 });
	}

	// Distinguish "release has no cover" (a legitimate 404) from a failed lookup
	// (network / Discogs error) — the latter is a logged 502 rather than silently
	// collapsing to a 404 that would read as a missing image.
	let url: string | null;
	try {
		url = await getReleaseImageUrl(id);
	} catch (err) {
		console.error(`discogsCoverResponse: lookup failed for release ${id}`, err);
		return new Response("Cover lookup failed", { status: 502 });
	}
	if (!url) {
		return new Response("No cover for this release", { status: 404 });
	}

	// The URL comes from Discogs' own API response, but validate its scheme/host
	// before fetching so a malformed or tampered response can't turn this endpoint
	// into an open proxy (SSRF).
	if (!isDiscogsImageUrl(url)) {
		console.error(
			`discogsCoverResponse: refusing non-Discogs cover URL for release ${id}: ${url}`,
		);
		return new Response("Unexpected cover URL", { status: 502 });
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
