import { DEFAULT_COLOR_NAME } from "#/lib/default-color";

/** The subset of a record the footer's stats sentence looks at. */
export interface StatsRecord {
	title: string | null;
	artist: string | null;
	year: number | null;
	size: string | null;
	colorName: string | null;
	discCount: number | null;
	notes: string | null;
}

export interface CollectionStats {
	total: number;
	oldest: { title: string; artist: string; year: number } | null;
	newestYear: number | null;
	coloured: number;
	/** The most common non-default vinyl colour, if any are coloured. */
	topColour: string | null;
	sevens: number;
	tens: number;
	/** The artist with the most records, if anyone has more than one. */
	topArtist: { name: string; count: number } | null;
	withNotes: number;
	multiDisc: number;
}

// Compilations' placeholder "artist" isn't one worth naming.
const VARIOUS = /^various( artists)?$/i;

export function collectionStats(records: StatsRecord[]): CollectionStats {
	let oldest: CollectionStats["oldest"] = null;
	let newestYear: number | null = null;
	let coloured = 0;
	let sevens = 0;
	let tens = 0;
	let withNotes = 0;
	let multiDisc = 0;
	const colours = new Map<string, number>();
	const artists = new Map<string, { name: string; count: number }>();

	for (const r of records) {
		if (r.year != null && r.year > 0) {
			if (!oldest || r.year < oldest.year) {
				if (r.title && r.artist)
					oldest = { title: r.title, artist: r.artist, year: r.year };
			}
			if (newestYear == null || r.year > newestYear) newestYear = r.year;
		}
		const colour = r.colorName ?? DEFAULT_COLOR_NAME;
		if (colour !== DEFAULT_COLOR_NAME) {
			coloured++;
			colours.set(colour, (colours.get(colour) ?? 0) + 1);
		}
		if (r.size === '7"') sevens++;
		if (r.size === '10"') tens++;
		if (r.notes?.trim()) withNotes++;
		if ((r.discCount ?? 1) > 1) multiDisc++;
		const artist = r.artist?.trim();
		if (artist && !VARIOUS.test(artist)) {
			const key = artist.toLowerCase();
			const entry = artists.get(key);
			if (entry) entry.count++;
			else artists.set(key, { name: artist, count: 1 });
		}
	}

	const topColour = [...colours].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
	const top = [...artists.values()].sort((a, b) => b.count - a.count)[0];
	return {
		total: records.length,
		oldest,
		newestYear,
		coloured,
		topColour,
		sevens,
		tens,
		topArtist: top && top.count > 1 ? top : null,
		withNotes,
		multiDisc,
	};
}
