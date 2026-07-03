import { env } from "cloudflare:workers";

/**
 * Discogs client. Uses a personal access token (no OAuth dance):
 *   Authorization: Discogs token=<DISCOGS_TOKEN>
 * A unique User-Agent is mandatory. 60 req/min authenticated.
 * https://www.discogs.com/developers
 */

const BASE = "https://api.discogs.com";
const USER_AGENT =
	"RecordsCharlieGleasonCom/1.0 +https://records.charliegleason.com";

export interface DiscogsCandidate {
	discogsId: string;
	artist: string;
	title: string;
	year: number | null;
	label: string | null;
	genre: string | null;
	format: string | null; // e.g. "Vinyl, 2×LP, Album, Reissue" — disambiguates pressings
	size: string | null; // physical size parsed from format, e.g. '12"'
	type: string | null; // release type parsed from format — LP / EP / Single
	country: string | null;
	catno: string | null; // catalog number
	discogsUrl: string;
	thumb: string | null;
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
	else if (/\bmaxi-single\b/i.test(text) || /\bsingle\b/i.test(text))
		type = "Single";
	else if (/\bLP\b/i.test(text) || /\balbum\b/i.test(text)) type = "LP";

	if (!size && type === "LP" && /\bLP\b|\bvinyl\b/i.test(text)) size = '12"';

	return { size, type };
}

function headers() {
	return {
		"User-Agent": USER_AGENT,
		Authorization: `Discogs token=${env.DISCOGS_TOKEN}`,
	};
}

/** Split a Discogs "Artist - Title" search result title into parts. */
function splitTitle(combined: string): { artist: string; title: string } {
	const idx = combined.indexOf(" - ");
	if (idx === -1) return { artist: "", title: combined };
	return {
		artist: combined.slice(0, idx).trim(),
		title: combined.slice(idx + 3).trim(),
	};
}

/** Full release details, fetched on demand when a candidate is expanded. */
export interface DiscogsReleaseDetail {
	// Canonical metadata — used to refresh a stored record from its Discogs id.
	artist: string | null;
	title: string | null;
	year: number | null;
	label: string | null;
	genre: string | null;
	catno: string | null;
	size: string | null; // parsed from `formats`, e.g. '12"'
	type: string | null; // parsed from `formats` — LP / EP / Single
	formats: string | null; // detailed, e.g. "2×LP, Album, Reissue, 180g, Gatefold"
	country: string | null;
	released: string | null;
	styles: Array<string>;
	notes: string | null;
	tracklist: Array<{ position: string; title: string; duration: string }>;
}

/** Strip Discogs' disambiguation suffix ("Wire (2)" → "Wire"). */
function cleanArtistName(name: string): string {
	return name.replace(/\s*\(\d+\)\s*$/, "").trim();
}

// biome-ignore lint/suspicious/noExplicitAny: untyped Discogs release JSON
function formatLine(f: any): string {
	const head = f?.qty && String(f.qty) !== "1" ? `${f.qty}×${f.name}` : f?.name;
	return [head, ...(Array.isArray(f?.descriptions) ? f.descriptions : [])]
		.filter(Boolean)
		.join(", ");
}

/** Fetch a single release's full details (tracklist, formats, styles, notes). */
export async function getReleaseDetail(
	id: string,
): Promise<DiscogsReleaseDetail | null> {
	const res = await fetch(`${BASE}/releases/${id}`, { headers: headers() });
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
		artist: d.artists_sort
			? cleanArtistName(String(d.artists_sort))
			: Array.isArray(d.artists) && d.artists[0]?.name
				? cleanArtistName(String(d.artists[0].name))
				: null,
		title: d.title ? String(d.title) : null,
		year: Number.isFinite(yearNum) ? yearNum : null,
		label: firstLabel?.name ? String(firstLabel.name) : null,
		genre: Array.isArray(d.genres) && d.genres[0] ? String(d.genres[0]) : null,
		catno: firstLabel?.catno ? String(firstLabel.catno) : null,
		size,
		type,
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

/** Highest-quality cover image URL for a release (primary image, full size). */
export async function getReleaseImageUrl(id: string): Promise<string | null> {
	const res = await fetch(`${BASE}/releases/${id}`, { headers: headers() });
	if (!res.ok) return null;
	const data = (await res.json()) as {
		images?: Array<{ type?: string; uri?: string }>;
	};
	const images = data.images ?? [];
	const primary = images.find((i) => i.type === "primary") ?? images[0];
	return primary?.uri ?? null;
}

const MAX_CANDIDATES = 5;
const isVinyl = (c: DiscogsCandidate) => /vinyl/i.test(c.format ?? "");

export type SearchParams = {
	artist: string;
	title: string;
	country: string;
	year: string;
};

export async function searchReleases({
	artist,
	title,
	country,
	year,
}: SearchParams): Promise<Array<DiscogsCandidate>> {
	const url = new URL(`${BASE}/database/search`);
	url.searchParams.set("type", "release");
	if (artist) url.searchParams.set("artist", artist);
	if (title) url.searchParams.set("release_title", title);
	if (country) url.searchParams.set("country", country);
	if (year) url.searchParams.set("year", year);
	// Pull a wider net so we can prefer vinyl below without losing other pressings.
	url.searchParams.set("per_page", "25");

	const res = await fetch(url, { headers: headers() });
	if (!res.ok) return [];

	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	const candidates = (data.results ?? []).map((r) => {
		const parts = splitTitle(String(r.title ?? ""));
		const yearNum = r.year ? Number.parseInt(String(r.year), 10) : null;
		const formatArr = Array.isArray(r.format) ? r.format.map(String) : [];
		const { size, type } = parseSizeAndType(formatArr);
		return {
			discogsId: String(r.id ?? ""),
			artist: parts.artist,
			title: parts.title,
			year: Number.isFinite(yearNum) ? yearNum : null,
			label: Array.isArray(r.label) ? String(r.label[0]) : null,
			genre: Array.isArray(r.genre) ? String(r.genre[0]) : null,
			format: formatArr.length ? formatArr.join(", ") : null,
			size,
			type,
			country: r.country ? String(r.country) : null,
			catno: r.catno ? String(r.catno) : null,
			discogsUrl: r.uri ? `https://www.discogs.com${r.uri}` : "",
			thumb: r.thumb ? String(r.thumb) : null,
		} satisfies DiscogsCandidate;
	});

	// Prefer vinyl pressings, but fall back to other formats so a CD/digital-only
	// title still returns matches. Discogs' relevance order is preserved per group.
	const vinyl = candidates.filter(isVinyl);
	const rest = candidates.filter((c) => !isVinyl(c));
	return [...vinyl, ...rest].slice(0, MAX_CANDIDATES);
}
