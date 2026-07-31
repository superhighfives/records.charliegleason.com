import type { Record } from "#/db/schema";
import { foldDiacritics } from "#/lib/records-path";

/**
 * Duplicate detection, kept pure and dependency-light so it's safe to import from
 * client routes too (unlike `analyze.ts`, which pulls in `cloudflare:workers`).
 * Both the background analysis (server) and the admin UI (client) match on the
 * same rules through here, so a record's "is this a duplicate?" answer can't drift
 * between the queue consumer and what the collector sees.
 */

/** A collection member for matching — just the identity fields the rules read. */
export type DuplicateCandidate = Pick<
	Record,
	"id" | "artist" | "title" | "masterId" | "discogsId"
>;

/** Lower-cased, diacritic-folded, punctuation-collapsed name for fuzzy comparison. */
function normalizeName(value: string | null | undefined): string {
	return foldDiacritics(value)
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * Decide whether a record already exists in the collection. Matches on Discogs
 * master (same album) first, then a specific release (same pressing), then a
 * normalized artist + title comparison so a re-photographed sleeve still gets
 * flagged even when Discogs didn't resolve. Returns the id of the existing record
 * it duplicates, or null. Pure: the caller supplies the rows to check against (the
 * record being matched must be excluded by the caller).
 */
export function findDuplicateOf(
	target: {
		artist: string;
		title: string;
		masterId: string | null;
		discogsId: string | null;
	},
	existing: Array<DuplicateCandidate>,
): number | null {
	const artist = normalizeName(target.artist);
	const title = normalizeName(target.title);
	const masterId = target.masterId?.trim() || null;
	const discogsId = target.discogsId?.trim() || null;

	// A blank identification can't meaningfully match anything.
	if (!masterId && !discogsId && (!artist || !title)) return null;

	// The caller's rows are unordered, so track the smallest id in each bucket to
	// keep the result deterministic and point at the earliest record. Match strength:
	// same album (master) > same pressing (release) > name-only.
	let masterMatch: number | null = null;
	let releaseMatch: number | null = null;
	let nameMatch: number | null = null;
	for (const row of existing) {
		if (masterId && row.masterId?.trim() === masterId) {
			if (masterMatch === null || row.id < masterMatch) masterMatch = row.id;
			continue;
		}
		if (discogsId && row.discogsId?.trim() === discogsId) {
			if (releaseMatch === null || row.id < releaseMatch) releaseMatch = row.id;
			continue;
		}
		if (
			artist &&
			title &&
			normalizeName(row.artist) === artist &&
			normalizeName(row.title) === title
		) {
			if (nameMatch === null || row.id < nameMatch) nameMatch = row.id;
		}
	}
	return masterMatch ?? releaseMatch ?? nameMatch;
}

/**
 * The id of a collection record this one is likely a duplicate of, or null — the
 * live signal behind the admin "possible duplicate" affordances (the badge, the
 * warning banner, and the "Own two of this?" copy prompt). Symmetric: both members
 * of a duplicate pair resolve to each other (each returns the earliest sibling), so
 * the affordance shows whichever record you're on. Only considers records that
 * aren't themselves linked copies (`copyOf` set) — a copy is already resolved, and
 * the real target is its primary. Unlike the stored `duplicateOf` flag (written only
 * by photo analysis, on the newer row), this recomputes against the current
 * collection, so manual/unmatched records and both siblings are covered.
 */
export function likelyDuplicateOf(
	record: DuplicateCandidate,
	all: Array<DuplicateCandidate & Pick<Record, "copyOf">>,
): number | null {
	const others = all.filter((r) => r.id !== record.id && r.copyOf == null);
	return findDuplicateOf(record, others);
}

/**
 * Every record id that has a likely duplicate sibling in the collection — the set
 * the admin list badge + `duplicate` filter key off, computed once per render.
 * Linked copies (`copyOf` set) are excluded: they're already resolved, so they
 * carry no "possible duplicate" warning.
 */
export function duplicateRecordIds(
	all: Array<DuplicateCandidate & Pick<Record, "copyOf">>,
): Set<number> {
	const ids = new Set<number>();
	for (const r of all) {
		if (r.copyOf == null && likelyDuplicateOf(r, all) != null) ids.add(r.id);
	}
	return ids;
}
