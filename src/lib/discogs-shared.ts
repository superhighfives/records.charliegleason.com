/**
 * Browser-safe Discogs helpers — pure result-shaping and URL building with no
 * `cloudflare:workers` / token dependency. Both the server client
 * (src/lib/discogs.ts) and the browser fallback (src/lib/discogs-browser.ts)
 * import from here so there's one source of truth for how a `/database/search`
 * master result maps to a candidate. discogs.ts re-exports the bits that already
 * had external callers, so their imports stay stable.
 */

export const DISCOGS_API_BASE = "https://api.discogs.com";
export const DEFAULT_PER_PAGE = 25;
export const MAX_PER_PAGE = 100;

/** A Discogs master (album) as a pick-list candidate. */
export interface DiscogsMasterCandidate {
	masterId: string;
	masterUrl: string | null;
	artist: string;
	title: string;
	year: number | null;
	genre: string | null;
	thumb: string | null;
}

/** The subset of search inputs a master search uses (no country/format axis). */
export interface MasterSearchParams {
	artist?: string;
	title?: string;
	year?: string;
	q?: string;
}

/** Split a Discogs "Artist - Title" search result title into parts. */
export function splitTitle(combined: string): { artist: string; title: string } {
	const idx = combined.indexOf(" - ");
	if (idx === -1) return { artist: "", title: combined };
	return {
		artist: combined.slice(0, idx).trim(),
		title: combined.slice(idx + 3).trim(),
	};
}

/**
 * Pull the master (album) id + url out of a release payload (either a full
 * `/releases/{id}` object or a `/database/search` result). Discogs uses
 * `master_id: 0` (and an empty/absent `master_url`) to mean "this release has no
 * master", so normalise those to null — a standalone release is album-less.
 */
export function masterFields(source: {
	master_id?: unknown;
	master_url?: unknown;
}): {
	masterId: string | null;
	masterUrl: string | null;
} {
	const id = Number(source?.master_id);
	const masterId = Number.isFinite(id) && id > 0 ? String(id) : null;
	const url =
		masterId && typeof source?.master_url === "string" && source.master_url
			? source.master_url
			: null;
	return { masterId, masterUrl: url };
}

/**
 * Build the Discogs `/database/search` URL for *masters* (albums). Unlike the
 * release search there's no country/format/vinyl axis — a master is the album as a
 * work — so only artist / title / year / free-text `q` apply. Pure + exported for
 * testing.
 */
export function buildMasterSearchUrl(
	{ artist, title, year, q }: MasterSearchParams,
	perPage: number = DEFAULT_PER_PAGE,
): URL {
	const url = new URL(`${DISCOGS_API_BASE}/database/search`);
	url.searchParams.set("type", "master");
	const [a, t, y, query] = [artist ?? "", title ?? "", year ?? "", q ?? ""].map(
		(s) => s.trim(),
	);
	if (a) url.searchParams.set("artist", a);
	if (t) url.searchParams.set("title", t);
	if (/^\d{4}$/.test(y)) url.searchParams.set("year", y);
	if (query) url.searchParams.set("q", query);
	url.searchParams.set("per_page", String(perPage));
	return url;
}

/**
 * Shape one `/database/search?type=master` result row into a
 * `DiscogsMasterCandidate`. A master result's own id is the master id;
 * `master_id`/`master_url` may also be present and equal, so prefer the explicit
 * field then fall back.
 */
export function mapMasterSearchResult(
	r: Record<string, unknown>,
): DiscogsMasterCandidate {
	const parts = splitTitle(String(r.title ?? ""));
	const yearNum = r.year ? Number.parseInt(String(r.year), 10) : null;
	const { masterId, masterUrl } = masterFields(r);
	return {
		masterId: masterId ?? String(r.id ?? ""),
		masterUrl: masterUrl ?? (r.uri ? `https://www.discogs.com${r.uri}` : null),
		artist: parts.artist,
		title: parts.title,
		year: yearNum != null && Number.isFinite(yearNum) ? yearNum : null,
		genre: Array.isArray(r.genre) ? String(r.genre[0]) : null,
		thumb: r.thumb ? String(r.thumb) : null,
	};
}
