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
	country: string | null;
	catno: string | null; // catalog number
	discogsUrl: string;
	thumb: string | null;
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
	formats: string | null; // detailed, e.g. "2×LP, Album, Reissue, 180g, Gatefold"
	country: string | null;
	released: string | null;
	styles: Array<string>;
	notes: string | null;
	tracklist: Array<{ position: string; title: string; duration: string }>;
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
	return {
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

export async function searchReleases(
	artist: string,
	title: string,
): Promise<Array<DiscogsCandidate>> {
	const url = new URL(`${BASE}/database/search`);
	url.searchParams.set("type", "release");
	if (artist) url.searchParams.set("artist", artist);
	if (title) url.searchParams.set("release_title", title);
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
		return {
			discogsId: String(r.id ?? ""),
			artist: parts.artist,
			title: parts.title,
			year: Number.isFinite(yearNum) ? yearNum : null,
			label: Array.isArray(r.label) ? String(r.label[0]) : null,
			genre: Array.isArray(r.genre) ? String(r.genre[0]) : null,
			format: Array.isArray(r.format) ? r.format.map(String).join(", ") : null,
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
