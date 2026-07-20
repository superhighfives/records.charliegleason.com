/**
 * Browser fallbacks for the interactive Discogs lookups in the admin editor
 * (searches + paste-a-URL), used when the server-side call is rate-limited (see
 * the MasterPicker / release CandidatePicker in src/routes/admin/records.$id.tsx).
 *
 * Why this exists: the Cloudflare Worker egresses from a shared IP pool that
 * Discogs rate-limits *per source IP* at its edge — so a valid token doesn't
 * help once neighbours on that IP have maxed the window. The admin's own browser
 * has a clean IP, so these re-run the same catalog GET from here instead.
 *
 * Unauthenticated on purpose: no token is sent from the browser (25 unauth
 * req/min per IP is ample for manual curation), which also keeps the request
 * CORS-preflight-free — Discogs answers these public catalog GETs with
 * `access-control-allow-origin: *`. Downside: Discogs only returns thumbnails /
 * cover images on *authenticated* requests, so `thumb` comes back null here — the
 * pick-list tolerates it. Marketplace value endpoints need auth (and aren't
 * CORS-open), so there's deliberately no browser fallback for those.
 *
 * All the URL building + result shaping is shared with the server client via
 * `#/lib/discogs-shared`, so a browser fallback maps a result identically to the
 * authenticated path (minus the token-gated images).
 */

import {
	buildMasterSearchUrl,
	buildSearchUrl,
	DISCOGS_API_BASE,
	type DiscogsCandidate,
	type DiscogsMasterCandidate,
	MAX_PER_PAGE,
	type MasterSearchParams,
	mapMasterDetail,
	mapMasterSearchResult,
	mapReleaseCandidate,
	mapReleaseSearchResult,
	masterDetailToCandidate,
	type ReleaseSearchParams,
} from "#/lib/discogs-shared";

/**
 * One unauthenticated Discogs GET from the browser, returning parsed JSON. Only
 * CORS-safelisted headers — an Authorization or User-Agent header would force a
 * preflight (and browsers forbid overriding User-Agent anyway). A plain GET stays
 * a "simple request" that Discogs' open CORS answers directly. Throws a
 * human-readable error (429-aware) on any non-2xx so the caller can surface it.
 */
async function discogsGetFromBrowser(
	url: string | URL,
	action: string,
): Promise<unknown> {
	const res = await fetch(url, { headers: { Accept: "application/json" } });
	if (!res.ok) {
		throw new Error(
			res.status === 429
				? "Discogs rate limit hit from your browser too — wait a moment and retry."
				: `Discogs ${action} failed (HTTP ${res.status}).`,
		);
	}
	return res.json();
}

/** Re-run the album (master) search from the browser's clean IP, unauthenticated. */
export async function searchMastersFromBrowser(
	params: MasterSearchParams,
): Promise<Array<DiscogsMasterCandidate>> {
	const data = (await discogsGetFromBrowser(
		buildMasterSearchUrl(params, MAX_PER_PAGE),
		"search",
	)) as { results?: Array<Record<string, unknown>> };
	return (data.results ?? [])
		.map(mapMasterSearchResult)
		.filter((c) => c.masterId !== "")
		.slice(0, MAX_PER_PAGE);
}

/** Re-run the release (pressing) search from the browser's clean IP, unauthenticated. */
export async function searchReleasesFromBrowser(
	params: ReleaseSearchParams,
): Promise<Array<DiscogsCandidate>> {
	const data = (await discogsGetFromBrowser(
		buildSearchUrl(params, MAX_PER_PAGE),
		"search",
	)) as { results?: Array<Record<string, unknown>> };
	return (data.results ?? [])
		.map(mapReleaseSearchResult)
		.filter((c) => c.discogsId !== "")
		.slice(0, MAX_PER_PAGE);
}

/**
 * Resolve a Discogs master id into a `DiscogsMasterCandidate` from the browser.
 * `thumb` will be null (images are token-gated), which the pick-list tolerates.
 */
export async function lookupMasterFromBrowser(
	id: string,
): Promise<DiscogsMasterCandidate> {
	const data = await discogsGetFromBrowser(
		`${DISCOGS_API_BASE}/masters/${id}`,
		"lookup",
	);
	return masterDetailToCandidate(mapMasterDetail(data, id));
}

/**
 * Resolve a Discogs release id into a `DiscogsCandidate` from the browser. `thumb`
 * will be null (images are token-gated).
 */
export async function lookupReleaseFromBrowser(
	id: string,
): Promise<DiscogsCandidate> {
	const data = await discogsGetFromBrowser(
		`${DISCOGS_API_BASE}/releases/${id}`,
		"lookup",
	);
	return mapReleaseCandidate(data, id);
}
