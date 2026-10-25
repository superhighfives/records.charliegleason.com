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
		return await findPitchforkScore(artist, title);
	} catch {
		return null;
	}
}

/**
 * {@link getPitchforkScore}, but a failed `albums.json` fetch throws rather
 * than reading as "no review" — for callers where the two mean different
 * things (see {@link pitchforkAfterRematch}).
 */
async function findPitchforkScore(
	artist: string,
	title: string,
): Promise<PitchforkScore | null> {
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
}

interface AlbumName {
	artist: string | null;
	title: string | null;
}

/** Same artist and title, ignoring case, accents and punctuation. */
export function sameAlbum(a: AlbumName, b: AlbumName): boolean {
	return (
		normalize(a.artist ?? "") === normalize(b.artist ?? "") &&
		normalize(a.title ?? "") === normalize(b.title ?? "")
	);
}

/**
 * What a save should do with the Pitchfork fields, given the album before and
 * after it. Analysis scores whatever it *guessed* the record was, so when the
 * collector picks the right match the old score belongs to a different album:
 *  - "keep": the album didn't change — leave the score alone.
 *  - "manual": it changed, but a score was typed in that differs from the old
 *    one — trust it, but drop the old review link.
 *  - "lookup": it changed and the score is untouched (or blank, or not part
 *    of this save) — look the new album up, clearing the score if there's none.
 */
export function pitchforkRematchAction(
	prev: AlbumName & { pitchforkScore: number | null },
	next: AlbumName,
	typedScore?: number | null,
): "keep" | "manual" | "lookup" {
	if (sameAlbum(prev, next)) return "keep";
	if (typedScore != null && typedScore !== prev.pitchforkScore) return "manual";
	return "lookup";
}

/**
 * The Pitchfork fields to write for a save that may have changed the album
 * (see {@link pitchforkRematchAction}), or `null` to leave them untouched.
 * If the lookup itself fails (The Fork unreachable), the previous score and
 * link are written back rather than cleared — a blip shouldn't read as "no
 * review", and the editor may have blanked the field in the form.
 */
export async function pitchforkAfterRematch(
	prev: AlbumName & {
		pitchforkScore: number | null;
		pitchforkUrl: string | null;
	},
	next: AlbumName,
	typedScore?: number | null,
): Promise<{
	pitchforkScore: number | null;
	pitchforkUrl: string | null;
} | null> {
	switch (pitchforkRematchAction(prev, next, typedScore)) {
		case "keep":
			return null;
		case "manual":
			return { pitchforkScore: typedScore ?? null, pitchforkUrl: null };
		case "lookup": {
			try {
				const found = await findPitchforkScore(
					next.artist ?? "",
					next.title ?? "",
				);
				return {
					pitchforkScore: found?.score ?? null,
					pitchforkUrl: found?.url ?? null,
				};
			} catch {
				return {
					pitchforkScore: prev.pitchforkScore,
					pitchforkUrl: prev.pitchforkUrl,
				};
			}
		}
	}
}
