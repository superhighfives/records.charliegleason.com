import { describe, expect, it } from "vitest";

import { mergeReleases, toRelease } from "./discogs-candidate";
import type { DiscogsCandidate } from "./discogs-shared";

function release(id: string): DiscogsCandidate {
	return {
		discogsId: id,
		masterId: null,
		masterUrl: null,
		artist: "A",
		title: "T",
		year: null,
		label: null,
		genre: null,
		format: null,
		size: null,
		type: null,
		discCount: 1,
		country: null,
		catno: null,
		discogsUrl: `https://www.discogs.com/release/${id}`,
		thumb: null,
	};
}

describe("mergeReleases", () => {
	it("keeps primary first and drops secondary duplicates by discogsId", () => {
		const merged = mergeReleases(
			[release("1"), release("2")],
			[release("2"), release("3")],
		);
		expect(merged.map((r) => r.discogsId)).toEqual(["1", "2", "3"]);
	});

	it("returns primary unchanged when secondary is empty (and vice versa)", () => {
		expect(mergeReleases([release("1")], []).map((r) => r.discogsId)).toEqual([
			"1",
		]);
		expect(mergeReleases([], [release("9")]).map((r) => r.discogsId)).toEqual([
			"9",
		]);
	});
});

describe("toRelease", () => {
	it("kind-prefixes the key so masters and releases can't collide", () => {
		expect(toRelease(release("5")).key).toBe("r:5");
	});
});
