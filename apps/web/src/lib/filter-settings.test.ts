import { describe, expect, it } from "vitest";
import { buildFacets, type FilterableRecord } from "#/lib/collection-filters";
import {
	DEFAULT_FILTER_SETTINGS,
	type FilterSettings,
	normalizeFilterSettings,
	stripGroups,
} from "#/lib/filter-settings";

const rec = (over: Partial<FilterableRecord> = {}): FilterableRecord => ({
	colorName: "Black",
	colorPalette: null,
	size: '12"',
	year: 1999,
	notes: null,
	...over,
});

const withGroup = (
	id: FilterSettings["groups"][number]["id"],
	over: Partial<FilterSettings["groups"][number]>,
): FilterSettings => ({
	groups: DEFAULT_FILTER_SETTINGS.groups.map((g) =>
		g.id === id ? { ...g, ...over } : g,
	),
});

describe("normalizeFilterSettings", () => {
	it("falls back to the defaults for junk", () => {
		expect(normalizeFilterSettings(null)).toEqual(DEFAULT_FILTER_SETTINGS);
		expect(normalizeFilterSettings({ groups: "nope" })).toEqual(
			DEFAULT_FILTER_SETTINGS,
		);
	});
	it("keeps stored order, drops invalid and duplicate groups, appends missing ones", () => {
		const out = normalizeFilterSettings({
			groups: [
				{ id: "size", enabled: true, label: "", minCount: 3, hidden: [] },
				{ id: "size", enabled: false, label: "Dup", minCount: 1, hidden: [] },
				{ id: "bogus", enabled: true, label: "x", minCount: 1, hidden: [] },
			],
		});
		expect(out.groups.map((g) => g.id)).toEqual([
			"size",
			"decade",
			"notes",
			"color",
		]);
		expect(out.groups[0]).toMatchObject({
			enabled: true,
			label: "Size",
			minCount: 3,
		});
	});
});

describe("stripGroups", () => {
	const facets = buildFacets([
		rec({ year: 1955, notes: "x" }),
		rec({ year: 1984, colorName: "Red" }),
		rec({ year: 1986, colorName: "Red" }),
		rec({ year: 1995, colorName: "Blue", size: '7"' }),
	]);

	it("matches the old strip by default: decade and notes only", () => {
		const groups = stripGroups(facets, DEFAULT_FILTER_SETTINGS);
		expect(groups.map((g) => g.id)).toEqual(["decade", "notes"]);
		expect(groups[0].chips.map((c) => c.label)).toEqual(["90s", "80s", "50s"]);
	});
	it("applies minCount and hidden chips", () => {
		const groups = stripGroups(
			facets,
			withGroup("decade", { minCount: 1, hidden: ["1950"] }),
		);
		expect(groups[0].chips.map((c) => c.value)).toEqual([1990, 1980]);
		const strict = stripGroups(facets, withGroup("decade", { minCount: 2 }));
		// Only the 80s has two records — one chip can't narrow anything.
		expect(strict.map((g) => g.id)).toEqual(["notes"]);
	});
	it("honours order, labels and enabling a group", () => {
		const settings: FilterSettings = {
			groups: [
				{ id: "color", enabled: true, label: "Vinyl", minCount: 1, hidden: [] },
				...DEFAULT_FILTER_SETTINGS.groups.filter((g) => g.id !== "color"),
			],
		};
		const groups = stripGroups(facets, settings);
		expect(groups[0]).toMatchObject({ id: "color", label: "Vinyl" });
		expect(groups[0].chips.map((c) => c.value)).toEqual([
			"Red",
			"Black",
			"Blue",
		]);
	});
});
