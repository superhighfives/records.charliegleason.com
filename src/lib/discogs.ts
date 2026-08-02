import { env } from "cloudflare:workers";
import { z } from "zod";
import {
	buildMasterSearchUrl,
	buildSearchUrl,
	cleanArtistName,
	cleanCatno,
	DEFAULT_PER_PAGE,
	DISCOGS_API_BASE,
	type DiscogsCandidate,
	type DiscogsMasterCandidate,
	type DiscogsMasterDetail,
	formatLine,
	MAX_PER_PAGE,
	mapMasterDetail,
	mapMasterSearchResult,
	mapReleaseCandidate,
	mapReleaseSearchResult,
	masterDetailToCandidate,
	masterFields,
	parseDiscCount,
	parseMasterId,
	parseReleaseId,
	parseSizeAndType,
} from "#/lib/discogs-shared";

// The pure helpers/mappers + result shapes live in the browser-safe shared module
// (so the browser fallback in discogs-browser.ts can reuse them). Re-export the ones
// with existing `#/lib/discogs` importers (records.ts, analyze.ts, the editor UI,
// tests) so their imports stay unchanged.
export {
	buildMasterSearchUrl,
	buildSearchUrl,
	MAX_PER_PAGE,
	parseMasterId,
	parseReleaseId,
	parseSizeAndType,
};
export type { DiscogsCandidate, DiscogsMasterCandidate, DiscogsMasterDetail };

/**
 * Discogs client. Uses a personal access token (no OAuth dance):
 *   Authorization: Discogs token=<DISCOGS_TOKEN>
 * A unique User-Agent is mandatory. 60 req/min authenticated.
 * https://www.discogs.com/developers
 */

const BASE = DISCOGS_API_BASE;
const USER_AGENT =
	"RecordsCharlieGleasonCom/1.0 +https://records.charliegleason.com";

function headers(): Record<string, string> {
	if (env.DISCOGS_PROXY_URL) {
		return { "X-Proxy-Secret": env.DISCOGS_PROXY_SECRET ?? "" };
	}
	return {
		"User-Agent": USER_AGENT,
		Authorization: `Discogs token=${env.DISCOGS_TOKEN}`,
	};
}

/**
 * Retarget a Discogs API URL at the Fly proxy (fly/discogs-proxy) when one's
 * configured, keeping the path + query intact. The proxy holds the real
 * DISCOGS_TOKEN and calls api.discogs.com from its own dedicated egress IP —
 * this is what routes around Discogs rate-limiting the Worker's shared
 * Cloudflare IP pool. Falls through to the original URL when unconfigured.
 */
function proxied(url: string | URL): string | URL {
	if (!env.DISCOGS_PROXY_URL) return url;
	const original = new URL(url);
	const target = new URL(env.DISCOGS_PROXY_URL);
	target.pathname = original.pathname;
	target.search = original.search;
	return target;
}

/** HTTP statuses worth another try — transient rate-limit / upstream blips. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_FETCH_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 250;
// Never block a request on a long Discogs `Retry-After`; the queue's own 15/30/60s
// backoff covers the longer waits, so cap what we'll wait inline.
const MAX_RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backoff before the next attempt: honor Discogs' `Retry-After` (seconds) when it
 * sends one on a 429, otherwise back off exponentially from a small base. Both
 * are capped so an inline request never stalls on a long rate-limit window.
 */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds > 0) {
		return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
	}
	return Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Fetch a Discogs endpoint with the auth headers, retrying transient failures a
 * few times with backoff. Discogs allows 60 req/min authenticated, so a burst can
 * trip a 429 that clears within a second or two — a bounded retry turns those
 * blips into a success instead of a swallowed "no match". Retries on 429/5xx and
 * on a thrown `fetch` (network/DNS/TLS reset) alike; a thrown fetch is rethrown on
 * the final attempt so it surfaces as an error rather than a swallowed empty
 * result. Non-retryable statuses (401, 404) and a genuine 2xx return on the first
 * response; the caller decides what to do with them.
 */
async function discogsFetch(url: string | URL): Promise<Response> {
	for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
		const last = attempt === MAX_FETCH_ATTEMPTS;
		let res: Response;
		try {
			res = await fetch(proxied(url), { headers: headers() });
		} catch (err) {
			// Network-level failure — transient too. Rethrow on the last attempt so
			// callers see a real error (not an empty result they'd treat as no-match).
			if (last) throw err;
			await sleep(retryDelayMs(attempt, null));
			continue;
		}

		if (res.ok || !RETRYABLE_STATUS.has(res.status) || last) return res;

		// Drain the discarded error body so the connection can be reused rather than
		// left dangling while we wait to retry.
		await res.body?.cancel().catch(() => {});
		await sleep(retryDelayMs(attempt, res.headers.get("Retry-After")));
	}
	// Unreachable — the final attempt always returns or throws — but satisfies TS.
	throw new Error("discogsFetch: exhausted retries");
}

/** Full release details, fetched on demand when a candidate is expanded. */
export interface DiscogsReleaseDetail {
	// Canonical metadata — used to refresh a stored record from its Discogs id.
	masterId: string | null; // the master (album) this release belongs to, if any
	masterUrl: string | null;
	artist: string | null;
	title: string | null;
	year: number | null;
	label: string | null;
	genre: string | null;
	catno: string | null;
	size: string | null; // parsed from `formats`, e.g. '12"'
	type: string | null; // parsed from `formats` — LP / EP / Single
	discCount: number; // number of discs, e.g. 2 for a 2×LP — parsed from format qty
	formats: string | null; // detailed, e.g. "2×LP, Album, Reissue, 180g, Gatefold"
	country: string | null;
	released: string | null;
	styles: Array<string>;
	notes: string | null;
	tracklist: Array<{ position: string; title: string; duration: string }>;
}

/** Fetch a single release's full details (tracklist, formats, styles, notes). */
export async function getReleaseDetail(
	id: string,
): Promise<DiscogsReleaseDetail | null> {
	const res = await discogsFetch(`${BASE}/releases/${id}`);
	if (!res.ok) return null;
	// biome-ignore lint/suspicious/noExplicitAny: untyped Discogs release JSON
	const d = (await res.json()) as any;

	// Size/type come from the descriptions across every format entry.
	const descriptions: Array<string> = Array.isArray(d.formats)
		? // biome-ignore lint/suspicious/noExplicitAny: untyped Discogs format JSON
			d.formats.flatMap((f: any) =>
				Array.isArray(f?.descriptions) ? f.descriptions.map(String) : [],
			)
		: [];
	const { size, type } = parseSizeAndType(descriptions);
	// biome-ignore lint/suspicious/noExplicitAny: untyped Discogs label JSON
	const firstLabel = Array.isArray(d.labels) ? (d.labels[0] as any) : null;
	const yearNum = d.year ? Number.parseInt(String(d.year), 10) : null;

	return {
		...masterFields(d),
		artist: d.artists_sort
			? cleanArtistName(String(d.artists_sort))
			: Array.isArray(d.artists) && d.artists[0]?.name
				? cleanArtistName(String(d.artists[0].name))
				: null,
		title: d.title ? String(d.title) : null,
		year: Number.isFinite(yearNum) ? yearNum : null,
		label: firstLabel?.name ? String(firstLabel.name) : null,
		genre: Array.isArray(d.genres) && d.genres[0] ? String(d.genres[0]) : null,
		catno: cleanCatno(firstLabel?.catno),
		size,
		type,
		discCount: parseDiscCount(Array.isArray(d.formats) ? d.formats : null),
		formats: Array.isArray(d.formats)
			? d.formats.map(formatLine).filter(Boolean).join(" / ") || null
			: null,
		country: d.country ? String(d.country) : null,
		released: d.released ? String(d.released) : null,
		styles: Array.isArray(d.styles) ? d.styles.map(String) : [],
		notes: d.notes ? String(d.notes) : null,
		tracklist: Array.isArray(d.tracklist)
			? d.tracklist.map(
					(t: { position?: unknown; title?: unknown; duration?: unknown }) => ({
						position: String(t?.position ?? ""),
						title: String(t?.title ?? ""),
						duration: String(t?.duration ?? ""),
					}),
				)
			: [],
	};
}

/**
 * Fetch a Discogs master (the album as a work). Used to refresh / populate the
 * album-level fields of a record that isn't pinned to a specific release. Returns
 * null on any non-2xx (missing master, token trouble) so callers can fall back to
 * whatever they already have. The raw JSON → {@link DiscogsMasterDetail} shaping
 * lives in `mapMasterDetail` (shared with the browser fallback).
 */
export async function getMasterDetail(
	id: string,
): Promise<DiscogsMasterDetail | null> {
	const res = await discogsFetch(`${BASE}/masters/${id}`);
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		return null;
	}
	return mapMasterDetail(await res.json(), id);
}

export type Liveness = "live" | "gone" | "inconclusive";

/**
 * Liveness of a Discogs resource, for the scheduled health check. Deliberately
 * three-valued rather than the boolean `getMasterDetail`/`getReleaseCandidate`
 * collapse to, because the health job must tell a *genuinely gone* resource (404 →
 * flag it) apart from a transient problem (token/proxy/5xx → leave the flag and
 * `checkedAt` untouched so it retries next run, rather than falsely flagging a live
 * one). `discogsFetch` already absorbs 429/5xx blips via retry, so a non-404 error
 * reaching here is inconclusive, not proof of death.
 *
 *   "live"         → 200, the resource resolves
 *   "gone"         → 404, deleted or merged on Discogs
 *   "inconclusive" → anything else (auth, proxy, network, exhausted retries)
 */
async function checkLiveness(url: string): Promise<Liveness> {
	let res: Response;
	try {
		res = await discogsFetch(url);
	} catch {
		return "inconclusive";
	}
	await res.body?.cancel().catch(() => {});
	if (res.ok) return "live";
	if (res.status === 404) return "gone";
	return "inconclusive";
}

/** Liveness of a Discogs master (album). See {@link checkLiveness}. */
export function checkMasterLiveness(id: string): Promise<Liveness> {
	return checkLiveness(`${BASE}/masters/${id}`);
}

/** Liveness of a Discogs release (pressing). See {@link checkLiveness}. */
export function checkReleaseLiveness(id: string): Promise<Liveness> {
	return checkLiveness(`${BASE}/releases/${id}`);
}

/**
 * Fetch a master and shape it into a `DiscogsMasterCandidate` so a pasted master
 * URL drops into the same pick-list as a search hit.
 */
export async function getMasterCandidate(
	id: string,
): Promise<DiscogsMasterCandidate | null> {
	const master = await getMasterDetail(id);
	return master ? masterDetailToCandidate(master) : null;
}

/** Is a Discogs versions row a vinyl pressing? Checks `major_formats` first. */
// biome-ignore lint/suspicious/noExplicitAny: untyped Discogs versions JSON
function isVinylVersion(v: any): boolean {
	const majors = Array.isArray(v?.major_formats)
		? v.major_formats.map((s: unknown) => String(s))
		: [];
	if (majors.length) return majors.some((f: string) => /vinyl/i.test(f));
	// Fall back to the free-text format line when major_formats is absent.
	return /vinyl|LP\b/i.test(String(v?.format ?? ""));
}

/**
 * List a master's releases (pressings) as `DiscogsCandidate`s so the editor can
 * offer "pick a specific pressing" once an album is chosen — vinyl only, since
 * that's the collection. The versions endpoint carries per-pressing fields but not
 * the artist/genre, so those come from the master (one extra fetch, cached). Each
 * candidate's `masterId` is the parent master. Returns [] on any failure.
 */
export async function getMasterVersions(
	masterId: string,
	limit: number = MAX_PER_PAGE,
): Promise<Array<DiscogsCandidate>> {
	const perPage = Math.min(Math.max(limit, DEFAULT_PER_PAGE), MAX_PER_PAGE);
	// Album-level fields (artist/genre/url) live on the master, not the versions.
	const master = await getMasterDetail(masterId).catch(() => null);
	const res = await discogsFetch(
		`${BASE}/masters/${masterId}/versions?per_page=${perPage}`,
	);
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		return [];
	}
	const data = (await res.json()) as {
		versions?: Array<Record<string, unknown>>;
	};
	return (data.versions ?? [])
		.filter(isVinylVersion)
		.map((v) => {
			const formatLine = v.format ? String(v.format) : "";
			const { size, type } = parseSizeAndType(formatLine);
			// Versions carry `released` (a year or full date) and sometimes `year`.
			const rawYear = v.released ?? v.year;
			const yearNum = rawYear
				? Number.parseInt(String(rawYear).slice(0, 4), 10)
				: null;
			return {
				discogsId: String(v.id ?? ""),
				masterId,
				masterUrl: master?.masterUrl ?? null,
				artist: master?.artist ?? "",
				title: v.title ? String(v.title) : (master?.title ?? ""),
				year: Number.isFinite(yearNum) ? yearNum : null,
				label: v.label ? String(v.label) : null,
				genre: master?.genre ?? null,
				format: formatLine || (isVinylVersion(v) ? "Vinyl" : null),
				size,
				type,
				discCount: parseDiscCount(formatLine),
				country: v.country ? String(v.country) : null,
				catno: cleanCatno(v.catno),
				discogsUrl: `https://www.discogs.com/release/${v.id}`,
				thumb: v.thumb ? String(v.thumb) : null,
			} satisfies DiscogsCandidate;
		})
		.filter((c) => c.discogsId !== "")
		.slice(0, limit);
}

/**
 * Fetch a single release and shape it into a `DiscogsCandidate` so a pasted URL
 * can drop straight into the same pick-list / publish flow as a search hit.
 */
export async function getReleaseCandidate(
	id: string,
): Promise<DiscogsCandidate | null> {
	const res = await discogsFetch(`${BASE}/releases/${id}`);
	if (!res.ok) return null;
	return mapReleaseCandidate(await res.json(), id);
}

/**
 * A record's estimated value, sourced from Discogs.
 *
 * `value`/`currency` are the single headline figure used for the collection
 * total; `suggestions` holds the full per-condition breakdown (only present when
 * the figure came from seller price suggestions). `source` records where the
 * number came from so the UI can caveat it: `suggestions` is Discogs' median
 * sale price for a grade (needs a Discogs Seller account), `stats` is the lowest
 * copy currently listed (the resilient fallback that works for any token).
 */
export interface DiscogsValue {
	value: number | null;
	currency: string;
	source: "suggestions" | "stats";
	numForSale: number | null; // copies currently for sale (from marketplace stats)
	suggestions: Record<string, number> | null; // condition label → price
}

/**
 * Which grade's suggested price we treat as *the* value. Discogs returns a price
 * per media condition; VG+ is the common resale baseline, so prefer it and walk
 * down (then up) to the next-best available grade if VG+ is missing.
 */
const VALUE_GRADE_PRIORITY = [
	"Very Good Plus (VG+)",
	"Near Mint (NM or M-)",
	"Very Good (VG)",
	"Mint (M)",
	"Good Plus (G+)",
	"Good (G)",
	"Fair (F)",
	"Poor (P)",
];

/** Raw Discogs price-suggestions payload: grade label → { value, currency }. */
type PriceSuggestions = Record<
	string,
	{ value?: unknown; currency?: unknown } | null | undefined
>;

/**
 * Reduce a Discogs price-suggestions payload to a flat `{ grade: price }` map
 * (dropping malformed entries) and the single headline grade we value against.
 * Pure + exported for testing.
 */
export function pickSuggestedValue(raw: PriceSuggestions): {
	value: number | null;
	currency: string | null;
	suggestions: Record<string, number>;
} {
	const suggestions: Record<string, number> = {};
	let currency: string | null = null;
	for (const [grade, entry] of Object.entries(raw ?? {})) {
		const rawValue = entry?.value;
		// Guard null/empty explicitly before coercing: `Number(null)` and
		// `Number("")` are both `0` (finite), which would otherwise record a bogus
		// $0 suggestion for a grade Discogs simply has no price for. A real
		// marketplace price is always positive, so drop non-positive values too.
		if (rawValue == null || rawValue === "") continue;
		const v = Number(rawValue);
		if (!Number.isFinite(v) || v <= 0) continue;
		suggestions[grade] = v;
		if (!currency && typeof entry?.currency === "string") {
			currency = entry.currency;
		}
	}
	const grade =
		VALUE_GRADE_PRIORITY.find((g) => g in suggestions) ??
		Object.keys(suggestions)[0];
	return {
		value: grade ? suggestions[grade] : null,
		currency,
		suggestions,
	};
}

/**
 * Estimate a release's value. Tries Discogs' seller price suggestions first (a
 * per-grade median that needs a Seller account) and falls back to marketplace
 * stats (the lowest copy currently listed) so the feature still returns a number
 * for tokens without seller access. Returns null only when neither endpoint
 * yields a usable figure. `curr` is the currency for the stats fallback; price
 * suggestions come back in the authenticated account's own currency.
 */
export async function getReleaseValue(
	id: string,
	curr = "USD",
): Promise<DiscogsValue | null> {
	// Seller price suggestions — the richer, grade-aware figure.
	const suggestRes = await discogsFetch(
		`${BASE}/marketplace/price_suggestions/${id}`,
	);
	if (suggestRes.ok) {
		const raw = (await suggestRes.json()) as PriceSuggestions;
		const { value, currency, suggestions } = pickSuggestedValue(raw);
		// Suggestions come back in the authenticated *account's* currency, which
		// isn't necessarily the one we total in. Only trust them when they match
		// `curr` (or don't declare a currency); otherwise fall through to the stats
		// endpoint below, which we explicitly request in `curr`. This keeps every
		// stored value in a single currency so the admin total sums correctly.
		if (value != null && (currency == null || currency === curr)) {
			return {
				value,
				currency: curr,
				source: "suggestions",
				numForSale: null,
				suggestions,
			};
		}
	} else {
		// 401/403 (no seller access), 404 (no suggestions) — drain and fall through.
		await suggestRes.body?.cancel().catch(() => {});
	}

	// Fallback: lowest copy currently for sale. Works for any authenticated token.
	const statsRes = await discogsFetch(
		`${BASE}/marketplace/stats/${id}?curr_abbr=${encodeURIComponent(curr)}`,
	);
	if (!statsRes.ok) {
		await statsRes.body?.cancel().catch(() => {});
		return null;
	}
	const stats = (await statsRes.json()) as {
		lowest_price?: { value?: unknown; currency?: unknown } | null;
		num_for_sale?: unknown;
	};
	const low = Number(stats.lowest_price?.value);
	const numForSale = Number(stats.num_for_sale);
	return {
		value: Number.isFinite(low) ? low : null,
		currency:
			typeof stats.lowest_price?.currency === "string"
				? stats.lowest_price.currency
				: curr,
		source: "stats",
		numForSale: Number.isFinite(numForSale) ? numForSale : null,
		suggestions: null,
	};
}

/** Highest-quality cover image URL for a release (primary image, full size). */
export async function getReleaseImageUrl(id: string): Promise<string | null> {
	const res = await discogsFetch(`${BASE}/releases/${id}`);
	if (!res.ok) {
		console.error(
			`getReleaseImageUrl: Discogs ${res.status} for release ${id}`,
		);
		return null;
	}
	const data = (await res.json()) as {
		images?: Array<{ type?: string; uri?: string }>;
	};
	const images = data.images ?? [];
	const primary = images.find((i) => i.type === "primary") ?? images[0];
	if (!primary?.uri) {
		// Discogs only returns `images` for authenticated requests — a missing
		// array usually means a token problem rather than an image-less release.
		console.error(
			`getReleaseImageUrl: no images in Discogs response for release ${id}`,
		);
	}
	return primary?.uri ?? null;
}

// The automated analyze path publishes the top hit and stores the rest for the
// review pick-list, so it caps at MAX_CANDIDATES — a shortlist long enough to
// hold the alternate pressings worth picking from without bloating every row's
// stored JSON. A manual search opts into the full result set — see `searchReleases`.
const MAX_CANDIDATES = 15;
// DEFAULT_PER_PAGE (25) / MAX_PER_PAGE (100 — Discogs' page cap) are imported from
// the shared module. The automated path pulls a modest page (enough to prefer
// vinyl without losing other pressings); a manual search asks for a full page so
// it can list as many pressings as one request returns.
const isVinyl = (c: DiscogsCandidate) => /vinyl/i.test(c.format ?? "");

/**
 * Manual/automated search inputs. Kept as trimmed, length-capped strings so
 * the server boundary can reject junk (non-strings, missing keys, abuse-length
 * values) before anything reaches Discogs. Empty string means "no filter".
 */
export const searchParamsSchema = z.object({
	artist: z.string().trim().max(200).default(""),
	title: z.string().trim().max(200).default(""),
	country: z.string().trim().max(100).default(""),
	year: z.string().trim().max(10).default(""),
	// Free-text keywords passed straight to Discogs' general `q` search — a
	// catch-all for anything the structured fields don't cover (label, catalog
	// number, format notes). Empty string means "no filter".
	q: z.string().trim().max(200).default(""),
});

export type SearchParams = z.infer<typeof searchParamsSchema>;

/**
 * Turn an unsuccessful Discogs response (any non-2xx) into a human-readable
 * error. Discogs puts a
 * useful reason in a JSON `message` field (e.g. "You must authenticate to access
 * this resource." for a bad token, or a rate-limit note on a 429) — surface it so
 * a failed search shows *why* instead of silently returning nothing.
 */
async function discogsError(res: Response, action: string): Promise<Error> {
	let detail = "";
	try {
		const body = (await res.json()) as { message?: unknown };
		if (typeof body.message === "string") detail = body.message;
	} catch {
		// Non-JSON body (HTML error page, empty) — the status alone will have to do.
	}
	const suffix = detail ? ` — ${detail}` : "";
	if (res.status === 401)
		return new Error(
			`Discogs rejected the request (check DISCOGS_TOKEN)${suffix}`,
		);
	if (res.status === 429)
		return new Error(`Discogs rate limit hit — try again shortly${suffix}`);
	return new Error(`Discogs ${action} failed (HTTP ${res.status})${suffix}`);
}

/**
 * Search Discogs for release candidates, vinyl pressings first.
 *
 * `limit` caps how many candidates come back (default `MAX_CANDIDATES`, the short
 * shortlist the automated analyze path stores). The manual review search passes
 * `MAX_PER_PAGE` so the admin can scroll a page of pressings and pick the exact
 * one. Only a single Discogs page is fetched, so at most `MAX_PER_PAGE` (100)
 * candidates come back even when Discogs reports more — that page is
 * relevance-ordered, so the closest matches are the ones kept.
 */
export async function searchReleases(
	params: SearchParams,
	limit: number = MAX_CANDIDATES,
): Promise<Array<DiscogsCandidate>> {
	// Fetch a page big enough to satisfy the limit, clamped to Discogs' 100/page.
	const perPage = Math.min(Math.max(limit, DEFAULT_PER_PAGE), MAX_PER_PAGE);
	const res = await discogsFetch(buildSearchUrl(params, perPage));
	// Don't swallow failures as an empty result — a bad token / rate limit / 5xx
	// is not "no matches". Throw so the caller can surface it; the automated
	// `analyze` path opts back into empty via its own `.catch(() => [])`.
	if (!res.ok) throw await discogsError(res, "search");

	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	const candidates = (data.results ?? []).map(mapReleaseSearchResult);

	// Prefer vinyl pressings, but fall back to other formats so a CD/digital-only
	// title still returns matches. Discogs' relevance order is preserved per group.
	const vinyl = candidates.filter(isVinyl);
	const rest = candidates.filter((c) => !isVinyl(c));
	return [...vinyl, ...rest].slice(0, limit);
}

/**
 * Search Discogs for master (album) candidates — the editor's "pick an album"
 * flow. Relevance-ordered; a single page is fetched, so at most `MAX_PER_PAGE`
 * come back. Throws on a non-2xx (bad token / rate limit / 5xx) like
 * `searchReleases`, so the caller can surface *why* rather than showing an empty
 * list. URL building + result shaping are shared with the browser fallback
 * (src/lib/discogs-browser.ts) via `#/lib/discogs-shared`.
 */
export async function searchMasters(
	params: SearchParams,
	limit: number = MAX_CANDIDATES,
): Promise<Array<DiscogsMasterCandidate>> {
	const perPage = Math.min(Math.max(limit, DEFAULT_PER_PAGE), MAX_PER_PAGE);
	const res = await discogsFetch(buildMasterSearchUrl(params, perPage));
	if (!res.ok) throw await discogsError(res, "master search");

	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	return (data.results ?? [])
		.map(mapMasterSearchResult)
		.filter((c) => c.masterId !== "")
		.slice(0, limit);
}
