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

export async function searchReleases(
	artist: string,
	title: string,
): Promise<Array<DiscogsCandidate>> {
	const url = new URL(`${BASE}/database/search`);
	url.searchParams.set("type", "release");
	if (artist) url.searchParams.set("artist", artist);
	if (title) url.searchParams.set("release_title", title);
	url.searchParams.set("per_page", "5");

	const res = await fetch(url, { headers: headers() });
	if (!res.ok) return [];

	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	return (data.results ?? []).map((r) => {
		const parts = splitTitle(String(r.title ?? ""));
		const yearNum = r.year ? Number.parseInt(String(r.year), 10) : null;
		return {
			discogsId: String(r.id ?? ""),
			artist: parts.artist,
			title: parts.title,
			year: Number.isFinite(yearNum) ? yearNum : null,
			label: Array.isArray(r.label) ? String(r.label[0]) : null,
			genre: Array.isArray(r.genre) ? String(r.genre[0]) : null,
			discogsUrl: r.uri ? `https://www.discogs.com${r.uri}` : "",
			thumb: r.thumb ? String(r.thumb) : null,
		};
	});
}
