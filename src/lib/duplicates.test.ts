import { describe, expect, it } from "vitest";

import {
	duplicateRecordIds,
	findDuplicateOf,
	likelyDuplicateOf,
} from "./duplicates";

/** A minimal collection member for the matcher (the only fields it reads). */
function rec(
	id: number,
	fields: Partial<{
		artist: string;
		title: string;
		masterId: string | null;
		discogsId: string | null;
		copyOf: number | null;
	}> = {},
) {
	return {
		id,
		artist: fields.artist ?? "Artist",
		title: fields.title ?? "Title",
		masterId: fields.masterId ?? null,
		discogsId: fields.discogsId ?? null,
		copyOf: fields.copyOf ?? null,
	};
}

describe("findDuplicateOf", () => {
	it("returns null when there's nothing identifiable to match on", () => {
		expect(
			findDuplicateOf(
				{ artist: "", title: "", masterId: null, discogsId: null },
				[rec(1, { artist: "A", title: "B" })],
			),
		).toBeNull();
	});

	it("matches on the same Discogs master", () => {
		const existing = [rec(1, { masterId: "m1" }), rec(2, { masterId: "m2" })];
		expect(
			findDuplicateOf(
				{ artist: "X", title: "Y", masterId: "m2", discogsId: null },
				existing,
			),
		).toBe(2);
	});

	it("prefers a master match over a release match over a name match", () => {
		// id 3 shares the master; id 1 only shares the release; id 2 only the name.
		const existing = [
			rec(1, { artist: "Diff", title: "Diff", discogsId: "r1" }),
			rec(2, { artist: "Same", title: "Name" }),
			rec(3, { masterId: "m1" }),
		];
		expect(
			findDuplicateOf(
				{ artist: "Same", title: "Name", masterId: "m1", discogsId: "r1" },
				existing,
			),
		).toBe(3);
	});

	it("falls back to a diacritic-folded artist + title match", () => {
		expect(
			findDuplicateOf(
				{ artist: "Björk", title: "Post", masterId: null, discogsId: null },
				[rec(7, { artist: "bjork", title: "post" })],
			),
		).toBe(7);
	});

	it("returns the earliest (smallest) id among equally-strong matches", () => {
		const existing = [rec(9, { masterId: "m1" }), rec(4, { masterId: "m1" })];
		expect(
			findDuplicateOf(
				{ artist: "X", title: "Y", masterId: "m1", discogsId: null },
				existing,
			),
		).toBe(4);
	});
});

describe("likelyDuplicateOf", () => {
	it("is symmetric — each member of a pair resolves to the earliest sibling", () => {
		const all = [rec(1, { masterId: "m1" }), rec(2, { masterId: "m1" })];
		// The newer points at the older...
		expect(likelyDuplicateOf(all[1], all)).toBe(1);
		// ...and the older points at the (only, newer) sibling — the affordance shows
		// whichever record you're on.
		expect(likelyDuplicateOf(all[0], all)).toBe(2);
	});

	it("ignores records already linked as copies", () => {
		// id 2 is a linked copy of id 1, so it's not a candidate to match against.
		const all = [
			rec(1, { masterId: "m1" }),
			rec(2, { masterId: "m1", copyOf: 1 }),
			rec(3, { masterId: "m1" }),
		];
		// id 3 matches id 1 (the primary), not the copy id 2.
		expect(likelyDuplicateOf(all[2], all)).toBe(1);
	});

	it("returns null for a record with no duplicate sibling", () => {
		// Distinct master AND distinct name, so nothing matches on any rule.
		const all = [
			rec(1, { masterId: "m1", title: "One" }),
			rec(2, { masterId: "m2", title: "Two" }),
		];
		expect(likelyDuplicateOf(all[0], all)).toBeNull();
	});
});

describe("duplicateRecordIds", () => {
	it("flags both members of a duplicate pair", () => {
		const all = [
			rec(1, { masterId: "m1" }),
			rec(2, { masterId: "m1" }),
			// Distinct master and name so it isn't a duplicate of the pair.
			rec(3, { masterId: "unique", artist: "Other", title: "Solo" }),
		];
		expect(duplicateRecordIds(all)).toEqual(new Set([1, 2]));
	});

	it("excludes linked copies from the flagged set", () => {
		const all = [
			rec(1, { masterId: "m1" }),
			rec(2, { masterId: "m1", copyOf: 1 }),
		];
		// id 2 is a resolved copy (no warning); id 1's only same-master sibling is that
		// copy, which isn't a candidate — so neither is flagged as a possible duplicate.
		expect(duplicateRecordIds(all)).toEqual(new Set());
	});

	it("returns an empty set when everything is unique", () => {
		const all = [
			rec(1, { masterId: "a", title: "One" }),
			rec(2, { masterId: "b", title: "Two" }),
		];
		expect(duplicateRecordIds(all)).toEqual(new Set());
	});
});
