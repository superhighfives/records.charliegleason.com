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

/**
 * A Discogs release (a specific pressing) as a pick-list candidate — the
 * pressing-level analogue of {@link DiscogsMasterCandidate}, carrying the
 * catno/country/size/format that distinguish one pressing from another.
 */
export interface DiscogsCandidate {
	discogsId: string;
	masterId: string | null; // the master (album) this release belongs to, if any
	masterUrl: string | null;
	artist: string;
	title: string;
	year: number | null;
	label: string | null;
	genre: string | null;
	format: string | null; // e.g. "Vinyl, 2×LP, Album, Reissue" — disambiguates pressings
	size: string | null; // physical size parsed from format, e.g. '12"'
	type: string | null; // release type parsed from format — LP / EP / Single
	discCount: number; // number of discs, e.g. 2 for a 2×LP — parsed from format qty
	country: string | null;
	catno: string | null; // catalog number
	discogsUrl: string;
	thumb: string | null;
}

/** Album-level details for a Discogs master (the album as a work). */
export interface DiscogsMasterDetail {
	masterId: string;
	masterUrl: string | null;
	mainReleaseId: string | null;
	artist: string | null;
	title: string | null;
	year: number | null; // the album's original year
	genre: string | null;
	styles: Array<string>;
	imageUrl: string | null; // primary image, full size
}

/** The structured inputs a release search accepts. Empty string means "no filter". */
export interface ReleaseSearchParams {
	artist?: string;
	title?: string;
	country?: string;
	year?: string;
	q?: string;
}

const SIZE_RE = /(\d{1,2})"/;

/**
 * Pull the physical size (e.g. `12"`) and release type (LP / EP / Single) out of
 * Discogs format descriptions. Accepts the raw descriptions array or a joined
 * string. Discogs tags vinyl inconsistently — a 12" album may be described as
 * "Album" with no "LP" — so `Album` folds to `LP` when nothing more specific hits.
 *
 * Discogs also omits an explicit size for standard 12" LPs (their descriptions
 * are just "LP"/"Album" — the size is implied), only spelling it out for odd
 * sizes and singles/EPs. So when no explicit size matched on a vinyl/LP release,
 * default to 12"; explicit tokens (7" singles, 10" EPs) still win. The vinyl
 * guard matters because `type` folds "Album" to "LP" even for CDs — without it a
 * CD album ("CD", "Album") would be mislabelled 12".
 */
export function parseSizeAndType(
	source: string | Array<string> | null | undefined,
): { size: string | null; type: string | null } {
	const text = Array.isArray(source) ? source.join(", ") : (source ?? "");
	if (!text) return { size: null, type: null };

	const sizeMatch = text.match(SIZE_RE);
	let size = sizeMatch ? `${sizeMatch[1]}"` : null;

	let type: string | null = null;
	if (/\bEP\b/i.test(text)) type = "EP";
	// "Single LP" (the capture-context preset) means a one-disc LP, not a 7"
	// single — check it before the bare "single" branch below.
	else if (/\bsingle\s+lp\b/i.test(text)) type = "LP";
	else if (/\bmaxi-single\b/i.test(text) || /\bsingle\b/i.test(text))
		type = "Single";
	else if (/\bLP\b/i.test(text) || /\balbum\b/i.test(text)) type = "LP";

	if (!size && type === "LP" && /\bLP\b|\bvinyl\b/i.test(text)) size = '12"';

	return { size, type };
}

/**
 * Extract disc count from Discogs format data — how many physical discs a release
 * ships as (a "2×LP" gatefold, a "3×LP" box set, etc). Accepts either the raw
 * `formats[]` array from a `/releases/{id}` payload (objects with `qty`/`name`,
 * the same shape {@link formatLine} reads), or the flat description text a
 * `/database/search` result already collapses qty into (e.g. "2xLP" inside the
 * joined format string). Defaults to 1 when nothing indicates otherwise.
 */
export function parseDiscCount(
	// biome-ignore lint/suspicious/noExplicitAny: untyped Discogs format JSON
	source: Array<any> | string | null | undefined,
): number {
	if (Array.isArray(source) && typeof source[0] === "object" && source[0]) {
		const qtys = source
			.filter(
				(f) =>
					typeof f?.name !== "string" ||
					source.length === 1 ||
					/vinyl/i.test(f.name),
			)
			.map((f) => Number.parseInt(String(f?.qty ?? "1"), 10))
			.filter((n) => Number.isFinite(n) && n > 0);
		return qtys.length ? Math.max(...qtys) : 1;
	}

	const text = Array.isArray(source) ? source.join(", ") : (source ?? "");
	const m = text.match(/(\d{1,2})\s*[x×]\s*(?:LP|EP|"|vinyl)/i);
	return m ? Number.parseInt(m[1], 10) : 1;
}

/**
 * Un-invert Discogs' sort-name convention ("Frames, The" → "The Frames",
 * "Ceres, A" → "A Ceres"). Discogs stores group names with a leading article
 * moved to the end so they alphabetize correctly; that's useful for sorting,
 * not for display.
 */
function reorderLeadingArticle(name: string): string {
	const m = name.match(/^(.+),\s*(The|An?)$/i);
	return m ? `${m[2]} ${m[1]}` : name;
}

/**
 * Canonicalise a Discogs artist name for display: strip the disambiguation
 * suffix ("Wire (2)" → "Wire") and un-invert a trailing sort article
 * ("Frames, The" → "The Frames").
 */
export function cleanArtistName(name: string): string {
	return reorderLeadingArticle(name.replace(/\s*\(\d+\)\s*$/, "").trim());
}

/**
 * Discogs sometimes stores placeholder catalog numbers ("none", "N/A", etc.)
 * instead of leaving the field blank. Normalise those to null so the UI shows
 * an empty field rather than a meaningless value.
 */
export function cleanCatno(catno: unknown): string | null {
	if (catno == null) return null;
	const trimmed = String(catno).trim();
	if (!trimmed) return null;
	if (/^(none|undefined|n\/?a|not applicable|n)$/i.test(trimmed)) return null;
	return trimmed;
}

/** Join a Discogs `formats[]` entry into a readable line ("2×LP, Album, Reissue"). */
// biome-ignore lint/suspicious/noExplicitAny: untyped Discogs release JSON
export function formatLine(f: any): string {
	const head = f?.qty && String(f.qty) !== "1" ? `${f.qty}×${f.name}` : f?.name;
	return [head, ...(Array.isArray(f?.descriptions) ? f.descriptions : [])]
		.filter(Boolean)
		.join(", ");
}

/**
 * Extract a Discogs release id from whatever the user pasted — a full release
 * URL (`https://www.discogs.com/release/30268103-Private-Life-Private-Life`),
 * a bare `/release/30268103` path, or just the numeric id. Returns null when
 * nothing looks like a release id (e.g. an artist/label/master URL).
 */
export function parseReleaseId(input: string): string | null {
	const s = input.trim();
	if (!s) return null;
	if (/^\d+$/.test(s)) return s;
	// Match /release/<id> or /releases/<id>, ignoring the trailing slug.
	const m = s.match(/\/releases?\/(\d+)/);
	return m ? m[1] : null;
}

/**
 * Extract a Discogs master id from a pasted master URL
 * (`https://www.discogs.com/master/12345-Some-Album`), a bare `/master/12345`
 * path, or just the numeric id. Returns null for anything that isn't a master
 * reference (a release URL won't match — use `parseReleaseId` for those).
 */
export function parseMasterId(input: string): string | null {
	const s = input.trim();
	if (!s) return null;
	if (/^\d+$/.test(s)) return s;
	const m = s.match(/\/masters?\/(\d+)/);
	return m ? m[1] : null;
}

/**
 * An Amazon ASIN for a physical product (vinyl, CD) — a 10-character code that
 * begins with `B` followed by 9 alphanumerics (e.g. `B00M30T9F2`). Book ASINs are
 * ISBN-10s (all digits / trailing `X`) and aren't handled here; records are the
 * B-prefixed form. Returns the normalised (upper-case) ASIN or null. The ASIN
 * isn't in Discogs — callers resolve it to artist/title/barcode first (see the
 * ASIN identify path) — but detecting it lets one search box accept a pasted ASIN.
 */
export function parseAsin(input: string): string | null {
	const s = input.trim().toUpperCase();
	return /^B[0-9A-Z]{9}$/.test(s) ? s : null;
}

/**
 * A retail barcode (UPC-A / EAN-13) as printed on a record sleeve — 12 or 13
 * digits, tolerant of the spaces/hyphens people paste off a product page. Discogs
 * indexes releases by barcode, so this is the one input that can pin an *exact*
 * pressing. Returns the digits-only barcode or null. Deliberately strict on length
 * (12–13) so a catalog number or a 4-digit year is never mistaken for a barcode.
 */
export function parseBarcode(input: string): string | null {
	const digits = input.trim().replace(/[\s-]/g, "");
	return /^\d{12,13}$/.test(digits) ? digits : null;
}

/** How the unified search field should route a raw input string. */
export type QueryRoute =
	| { kind: "release-url"; id: string }
	| { kind: "master-url"; id: string }
	| { kind: "asin"; asin: string }
	| { kind: "barcode"; barcode: string }
	| { kind: "text"; text: string };

/**
 * Decide what a single free-text search box should *do* with what was typed, so
 * one field can accept a Discogs release/master URL, an Amazon ASIN, a barcode, or
 * plain keywords. Only an explicit `/release/`|`/master/` path counts as a URL — a
 * bare number is treated as keywords (too ambiguous to be an id), so pasting a URL
 * is unambiguous while typing `1971` still searches. ASIN and barcode are
 * shape-detected; everything else falls through to a keyword search.
 */
export function classifyQuery(input: string): QueryRoute {
	const s = input.trim();
	const releaseMatch = s.match(/\/releases?\/(\d+)/);
	if (releaseMatch) return { kind: "release-url", id: releaseMatch[1] };
	const masterMatch = s.match(/\/masters?\/(\d+)/);
	if (masterMatch) return { kind: "master-url", id: masterMatch[1] };
	const asin = parseAsin(s);
	if (asin) return { kind: "asin", asin };
	const barcode = parseBarcode(s);
	if (barcode) return { kind: "barcode", barcode };
	return { kind: "text", text: s };
}

/**
 * Build the Discogs `/database/search` URL for *releases* (pressings), normalising
 * inputs so whitespace misses and invalid years never reach Discogs. Pure +
 * exported for testing. (Masters use {@link buildMasterSearchUrl}.)
 */
export function buildSearchUrl(
	{ artist, title, country, year, q }: ReleaseSearchParams,
	perPage: number = DEFAULT_PER_PAGE,
): URL {
	const url = new URL(`${DISCOGS_API_BASE}/database/search`);
	url.searchParams.set("type", "release");
	const [a, t, c, y, query] = [
		artist ?? "",
		title ?? "",
		country ?? "",
		year ?? "",
		q ?? "",
	].map((s) => s.trim());
	if (a) url.searchParams.set("artist", a);
	if (t) url.searchParams.set("release_title", t);
	if (c) url.searchParams.set("country", c);
	// Discogs expects a bare 4-digit year; ignore anything else rather than
	// sending junk that just returns zero matches.
	if (/^\d{4}$/.test(y)) url.searchParams.set("year", y);
	// General keyword search — AND-ed with the structured filters above.
	if (query) url.searchParams.set("q", query);
	url.searchParams.set("per_page", String(perPage));
	return url;
}

/**
 * Build the Discogs `/database/search` URL for a barcode (UPC/EAN) lookup — the
 * exact-pressing fast path. Barcodes are release-level (a pressing carries the
 * barcode, not the album), so `type=release`. Pure + exported for testing.
 */
export function buildBarcodeSearchUrl(
	barcode: string,
	perPage: number = DEFAULT_PER_PAGE,
): URL {
	const url = new URL(`${DISCOGS_API_BASE}/database/search`);
	url.searchParams.set("type", "release");
	url.searchParams.set("barcode", barcode.trim());
	url.searchParams.set("per_page", String(perPage));
	return url;
}

/** Shape one `/database/search?type=release` result row into a {@link DiscogsCandidate}. */
export function mapReleaseSearchResult(
	r: Record<string, unknown>,
): DiscogsCandidate {
	const parts = splitTitle(String(r.title ?? ""));
	const yearNum = r.year ? Number.parseInt(String(r.year), 10) : null;
	const formatArr = Array.isArray(r.format) ? r.format.map(String) : [];
	const { size, type } = parseSizeAndType(formatArr);
	return {
		discogsId: String(r.id ?? ""),
		...masterFields(r),
		artist: parts.artist,
		title: parts.title,
		year: Number.isFinite(yearNum) ? yearNum : null,
		label: firstArrayString(r.label),
		genre: firstArrayString(r.genre),
		format: formatArr.length ? formatArr.join(", ") : null,
		size,
		type,
		discCount: parseDiscCount(formatArr),
		country: r.country ? String(r.country) : null,
		catno: cleanCatno(r.catno),
		discogsUrl: r.uri ? `https://www.discogs.com${r.uri}` : "",
		thumb: r.thumb ? String(r.thumb) : null,
	};
}

/**
 * Shape a full `/releases/{id}` payload into a {@link DiscogsCandidate} so a pasted
 * URL drops straight into the same pick-list / publish flow as a search hit. Note:
 * Discogs only returns `images` on authenticated requests, so `thumb` will be null
 * on an unauthenticated (browser-fallback) fetch.
 */
export function mapReleaseCandidate(
	// biome-ignore lint/suspicious/noExplicitAny: untyped Discogs release JSON
	d: any,
	fallbackId: string,
): DiscogsCandidate {
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
	const images: Array<{ type?: string; uri?: string; uri150?: string }> =
		Array.isArray(d.images) ? d.images : [];
	const primary = images.find((i) => i.type === "primary") ?? images[0];
	const uri = d.uri ? String(d.uri) : "";

	return {
		discogsId: String(d.id ?? fallbackId),
		...masterFields(d),
		artist: d.artists_sort
			? cleanArtistName(String(d.artists_sort))
			: Array.isArray(d.artists) && d.artists[0]?.name
				? cleanArtistName(String(d.artists[0].name))
				: "",
		title: d.title ? String(d.title) : "",
		year: Number.isFinite(yearNum) ? yearNum : null,
		label: firstLabel?.name ? String(firstLabel.name) : null,
		genre: Array.isArray(d.genres) && d.genres[0] ? String(d.genres[0]) : null,
		format: Array.isArray(d.formats)
			? d.formats.map(formatLine).filter(Boolean).join(", ") || null
			: null,
		size,
		type,
		discCount: parseDiscCount(Array.isArray(d.formats) ? d.formats : null),
		country: d.country ? String(d.country) : null,
		catno: cleanCatno(firstLabel?.catno),
		discogsUrl: uri
			? uri.startsWith("http")
				? uri
				: `https://www.discogs.com${uri}`
			: `https://www.discogs.com/release/${fallbackId}`,
		thumb: primary?.uri150 ?? primary?.uri ?? null,
	};
}

/**
 * Shape a full `/masters/{id}` payload into {@link DiscogsMasterDetail}. As with
 * releases, `imageUrl` will be null on an unauthenticated fetch (images are
 * token-gated).
 */
export function mapMasterDetail(
	// biome-ignore lint/suspicious/noExplicitAny: untyped Discogs master JSON
	d: any,
	fallbackId: string,
): DiscogsMasterDetail {
	const yearNum = d.year ? Number.parseInt(String(d.year), 10) : null;
	const mainRelease = d.main_release != null ? String(d.main_release) : null;
	const images: Array<{ type?: string; uri?: string }> = Array.isArray(d.images)
		? d.images
		: [];
	const primary = images.find((i) => i.type === "primary") ?? images[0];
	const uri = d.uri ? String(d.uri) : "";

	return {
		masterId: String(d.id ?? fallbackId),
		masterUrl: uri
			? uri.startsWith("http")
				? uri
				: `https://www.discogs.com${uri}`
			: `https://www.discogs.com/master/${fallbackId}`,
		mainReleaseId: mainRelease,
		artist: d.artists_sort
			? cleanArtistName(String(d.artists_sort))
			: Array.isArray(d.artists) && d.artists[0]?.name
				? cleanArtistName(String(d.artists[0].name))
				: null,
		title: d.title ? String(d.title) : null,
		year: Number.isFinite(yearNum) ? yearNum : null,
		genre: Array.isArray(d.genres) && d.genres[0] ? String(d.genres[0]) : null,
		styles: Array.isArray(d.styles) ? d.styles.map(String) : [],
		imageUrl: primary?.uri ?? null,
	};
}

/** Reduce a {@link DiscogsMasterDetail} to a pick-list {@link DiscogsMasterCandidate}. */
export function masterDetailToCandidate(
	master: DiscogsMasterDetail,
): DiscogsMasterCandidate {
	return {
		masterId: master.masterId,
		masterUrl: master.masterUrl,
		artist: master.artist ?? "",
		title: master.title ?? "",
		year: master.year,
		genre: master.genre,
		thumb: master.imageUrl,
	};
}

/**
 * First element of a Discogs array field (`label`, `genre`, …) as a string, or
 * null when the array is empty/absent. Guards the `String(arr[0])` footgun: an
 * empty `[]` makes `arr[0]` `undefined`, and `String(undefined)` is the literal
 * `"undefined"` — which would then display + persist as the label/genre.
 */
export function firstArrayString(v: unknown): string | null {
	return Array.isArray(v) && v[0] != null ? String(v[0]) : null;
}

/** Split a Discogs "Artist - Title" search result title into parts. */
export function splitTitle(combined: string): {
	artist: string;
	title: string;
} {
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
		genre: firstArrayString(r.genre),
		thumb: r.thumb ? String(r.thumb) : null,
	};
}
