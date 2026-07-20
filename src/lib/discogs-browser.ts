/**
 * Browser fallback for the album search, used when the server-side search is
 * rate-limited (see the MasterLinker in src/routes/admin/records.$id.tsx).
 *
 * Why this exists: the Cloudflare Worker egresses from a shared IP pool that
 * Discogs rate-limits *per source IP* at its edge — so a valid token doesn't
 * help once neighbours on that IP have maxed the window. The admin's own browser
 * has a clean IP, so this runs the same `/database/search` from here instead.
 *
 * Unauthenticated on purpose: no token is sent from the browser (25 unauth
 * req/min per IP is ample for manual linking), which also keeps the request
 * CORS-preflight-free — Discogs sends `access-control-allow-origin: *`. Downside:
 * thumbnails can be absent on unauthenticated results, which the pick-list
 * tolerates.
 */

import {
	buildMasterSearchUrl,
	type DiscogsMasterCandidate,
	type MasterSearchParams,
	mapMasterSearchResult,
	MAX_PER_PAGE,
} from "#/lib/discogs-shared";

export async function searchMastersFromBrowser(
	params: MasterSearchParams,
): Promise<Array<DiscogsMasterCandidate>> {
	const url = buildMasterSearchUrl(params, MAX_PER_PAGE);
	// Only CORS-safelisted headers — an Authorization or User-Agent header would
	// force a preflight (and browsers forbid overriding User-Agent anyway). A plain
	// GET stays a "simple request" that Discogs' open CORS answers directly.
	const res = await fetch(url, { headers: { Accept: "application/json" } });
	if (!res.ok) {
		throw new Error(
			res.status === 429
				? "Discogs rate limit hit from your browser too — wait a moment and retry."
				: `Discogs search failed (HTTP ${res.status}).`,
		);
	}
	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	return (data.results ?? [])
		.map(mapMasterSearchResult)
		.filter((c) => c.masterId !== "")
		.slice(0, MAX_PER_PAGE);
}
