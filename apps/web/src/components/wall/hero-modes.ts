import { DEFAULT_COLOR_NAME } from "#/lib/default-color";
import { numberToWords } from "#/lib/number-to-words";
import type { PublicRecord } from "#/lib/records";

/**
 * Prototype: different ways to open the wall, picked with `?hero=`.
 *
 * - `default` — the hero and the stats sentence centred over a gap in the
 *   wall, moving with it until dragged away.
 * - `panel` — the same, hung *on* the wall: in perspective, curving and
 *   parallaxing with the records around it.
 * - `labels` — the hero alone; the stats become small captions under the
 *   records they're about, found as you explore.
 * - `plaque` — the hero with the stats as a small museum-style wall text.
 * - `record` — opens zoomed in on the newest record, the hero as its
 *   caption, pulling back to the wall as soon as you move.
 * - `facts` — the hero alone, big; previous / next buttons in the filter
 *   pill step the camera through the records the stats are about, each with
 *   its fact as a caption.
 */
export const HERO_MODES = [
	"default",
	"panel",
	"labels",
	"plaque",
	"record",
	"facts",
] as const;
export type HeroMode = (typeof HERO_MODES)[number];

export function readHeroMode(): HeroMode {
	const value = new URLSearchParams(window.location.search).get("hero");
	return HERO_MODES.find((m) => m === value) ?? "default";
}

/** A record the stats are about, and what to say about it. */
export type Featured = { recordId: number; caption: string };

const words = (n: number) => numberToWords(n);
const VARIOUS = /^various/i;

/**
 * The records behind the stats sentence's clauses, in its order — the
 * oldest, the newest, a coloured one, a seven, the most discs, the artist
 * who turns up most — each with a short caption.
 */
export function featuredRecords(records: PublicRecord[]): Featured[] {
	const out: Featured[] = [];
	const dated = records.filter((r) => r.year != null && r.year > 0);
	const oldest = dated.reduce<PublicRecord | null>(
		(a, r) => (!a || (r.year ?? 0) < (a.year ?? 0) ? r : a),
		null,
	);
	if (oldest) {
		out.push({
			recordId: oldest.id,
			caption: `The oldest, from ${oldest.year}`,
		});
	}
	const newest = dated.reduce<PublicRecord | null>(
		(a, r) => (!a || (r.year ?? 0) > (a.year ?? 0) ? r : a),
		null,
	);
	if (newest && newest.id !== oldest?.id) {
		out.push({
			recordId: newest.id,
			caption: `The newest, from ${newest.year}`,
		});
	}
	const colours = new Map<string, PublicRecord[]>();
	for (const r of records) {
		if (!r.colorName || r.colorName === DEFAULT_COLOR_NAME) continue;
		colours.set(r.colorName, [...(colours.get(r.colorName) ?? []), r]);
	}
	const coloured = [...colours.values()].flat().length;
	const top = [...colours.entries()].sort(
		(a, b) => b[1].length - a[1].length,
	)[0];
	if (top) {
		out.push({
			recordId: top[1][0].id,
			caption: `${top[0]} — one of ${words(coloured)} on coloured vinyl`,
		});
	}
	const seven = records.find((r) => r.size === '7"');
	if (seven) out.push({ recordId: seven.id, caption: "A seven" });
	const discs = records.reduce<PublicRecord | null>(
		(a, r) => ((r.discCount ?? 1) > (a?.discCount ?? 1) ? r : a),
		null,
	);
	if (discs && (discs.discCount ?? 1) > 1) {
		out.push({
			recordId: discs.id,
			caption: `Across ${words(discs.discCount ?? 1)} discs`,
		});
	}
	const artists = new Map<string, PublicRecord[]>();
	for (const r of records) {
		const name = r.artist?.trim();
		if (!name || VARIOUS.test(name)) continue;
		const key = name.toLowerCase();
		artists.set(key, [...(artists.get(key) ?? []), r]);
	}
	const most = [...artists.values()].sort((a, b) => b.length - a.length)[0];
	if (most && most.length > 1) {
		out.push({
			recordId: most[0].id,
			caption: `${most[0].artist} turns up ${words(most.length)} times`,
		});
	}
	return out;
}

/** The record added most recently. */
export function newestRecord(records: PublicRecord[]): PublicRecord | null {
	let best: PublicRecord | null = null;
	let at = Number.NEGATIVE_INFINITY;
	for (const r of records) {
		const t = new Date(r.createdAt as unknown as string).getTime();
		if (t > at) {
			at = t;
			best = r;
		}
	}
	return best;
}
