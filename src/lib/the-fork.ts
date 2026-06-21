/**
 * The Fork (the-fork.vercel.app) — Pitchfork review scores.
 *
 * The Fork is a static site that ships its whole dataset as `albums.json` and
 * searches client-side — there's no query API. So we fetch that file (edge- and
 * isolate-cached) and match against it ourselves. Each entry:
 *   { artist, title, score (0–10), bnm, bnr, genres[], url, releaseYear, image }
 * `url` is a relative Pitchfork review path.
 */

const ALBUMS_URL = "https://the-fork.vercel.app/albums.json";
const PITCHFORK = "https://pitchfork.com";
const TTL_MS = 6 * 60 * 60 * 1000;

interface ForkAlbum {
	artist: string;
	title: string;
	score: number;
	url: string;
}

export interface PitchforkScore {
	score: number;
	url: string | null;
}

let cache: { at: number; albums: Array<ForkAlbum> } | null = null;

function normalize(s: string): string {
	// NFD splits accented letters into base + combining mark; the alphanumeric
	// filter then drops the marks, curly quotes, and punctuation in one pass.
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

async function loadAlbums(): Promise<Array<ForkAlbum>> {
	if (cache && Date.now() - cache.at < TTL_MS) return cache.albums;
	const res = await fetch(ALBUMS_URL, {
		cf: { cacheTtl: 21600, cacheEverything: true },
	} as RequestInit);
	if (!res.ok) throw new Error(`albums.json ${res.status}`);
	const albums = (await res.json()) as Array<ForkAlbum>;
	cache = { at: Date.now(), albums };
	return albums;
}

export async function getPitchforkScore(
	artist: string,
	title: string,
): Promise<PitchforkScore | null> {
	try {
		const albums = await loadAlbums();
		const a = normalize(artist);
		const t = normalize(title);
		if (!a || !t) return null;

		const exact = albums.find(
			(x) => normalize(x.artist) === a && normalize(x.title) === t,
		);
		const match =
			exact ??
			albums.find((x) => {
				const xa = normalize(x.artist);
				const xt = normalize(x.title);
				return (xa === a || xa.includes(a) || a.includes(xa)) && xt === t;
			});

		if (!match || typeof match.score !== "number") return null;
		return {
			score: match.score,
			url: match.url ? `${PITCHFORK}${match.url}` : null,
		};
	} catch {
		return null;
	}
}
