/**
 * A pickable Discogs identity — a *master* (album) or a *release* (specific
 * pressing) — merged into one union so a single pick-list can offer both. A master
 * search alone misses albums Discogs files under an odd master title (e.g. "Led
 * Zeppelin IV", whose canonical master is untitled), whereas the pressings surface
 * reliably; offering both covers the gap. `key` is a kind-prefixed unique id so a
 * master and a release can never collide in the picker.
 *
 * Browser-safe (no `cloudflare:workers`): shared by the bulk assign dialog, the
 * unified search field, and the editor pickers.
 */

import type {
	DiscogsCandidate,
	DiscogsMasterCandidate,
} from "#/lib/discogs-shared";

export type Candidate =
	| { kind: "master"; key: string; data: DiscogsMasterCandidate }
	| { kind: "release"; key: string; data: DiscogsCandidate };

export const toMaster = (m: DiscogsMasterCandidate): Candidate => ({
	kind: "master",
	key: `m:${m.masterId}`,
	data: m,
});

export const toRelease = (r: DiscogsCandidate): Candidate => ({
	kind: "release",
	key: `r:${r.discogsId}`,
	data: r,
});

/** "Artist — Title (Year)" headline, shared by masters and releases. */
export function candidateLabel(c: Candidate): string {
	const { artist, title, year } = c.data;
	return `${artist} — ${title}${year ? ` (${year})` : ""}`;
}

/**
 * The distinguishing detail line — what tells two same-titled options apart. For a
 * master that's mostly the genre; for a release it's the pressing specifics
 * (format, size, country, label, catalog number) that make one pressing not
 * another. Empty parts are dropped.
 */
export function candidateDetail(c: Candidate): string {
	if (c.kind === "master") {
		return [c.data.genre].filter(Boolean).join(" · ");
	}
	const r = c.data;
	return [r.type ?? r.format, r.size, r.country, r.label, r.catno]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Concatenate two release lists, dropping any secondary entry already present in
 * primary (matched on `discogsId`), order preserved. Used by the ASIN flow to put
 * exact barcode hits ahead of the broader filtered shortlist without listing the
 * same pressing twice.
 */
export function mergeReleases(
	primary: Array<DiscogsCandidate>,
	secondary: Array<DiscogsCandidate>,
): Array<DiscogsCandidate> {
	const seen = new Set(primary.map((r) => r.discogsId));
	return [...primary, ...secondary.filter((r) => !seen.has(r.discogsId))];
}

type MasterCandidate = Extract<Candidate, { kind: "master" }>;
type ReleaseCandidate = Extract<Candidate, { kind: "release" }>;

/**
 * Split a merged candidate list back into its master/release groups, order kept.
 * Narrows each group so `.data` is the concrete master/release shape, not the union.
 */
export function groupCandidates(candidates: Array<Candidate>): {
	masters: Array<MasterCandidate>;
	releases: Array<ReleaseCandidate>;
} {
	return {
		masters: candidates.filter(
			(c): c is MasterCandidate => c.kind === "master",
		),
		releases: candidates.filter(
			(c): c is ReleaseCandidate => c.kind === "release",
		),
	};
}
