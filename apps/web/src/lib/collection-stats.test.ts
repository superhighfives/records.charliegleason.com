import { describe, expect, it } from "vitest";
import { collectionStats, type StatsRecord } from "#/lib/collection-stats";

const rec = (over: Partial<StatsRecord> = {}): StatsRecord => ({
	title: "T",
	artist: "A",
	year: 2000,
	size: '12"',
	colorName: "Black",
	discCount: 1,
	notes: null,
	...over,
});

describe("collectionStats", () => {
	it("summarises the collection", () => {
		const stats = collectionStats([
			rec({ title: "Old", artist: "Elder", year: 1967 }),
			rec({ artist: "Band", year: 2024, colorName: "Red", size: '7"' }),
			rec({ artist: "band", colorName: "Red", notes: "hi", discCount: 2 }),
			rec({ artist: "Various", colorName: "Blue", size: '10"' }),
			rec({ artist: "Various" }),
		]);
		expect(stats).toEqual({
			total: 5,
			oldest: { title: "Old", artist: "Elder", year: 1967 },
			newestYear: 2024,
			coloured: 3,
			topColour: "Red",
			sevens: 1,
			tens: 1,
			topArtist: { name: "Band", count: 2 },
			withNotes: 1,
			multiDisc: 1,
		});
	});

	it("has no top artist when nobody repeats, and ignores missing years", () => {
		const stats = collectionStats([
			rec({ artist: "X", year: null }),
			rec({ artist: "Y", year: 0 }),
		]);
		expect(stats.topArtist).toBeNull();
		expect(stats.oldest).toBeNull();
		expect(stats.newestYear).toBeNull();
		expect(stats.topColour).toBeNull();
	});
});
