import { describe, expect, it } from "vitest";
import {
	buildFacets,
	decadeLabel,
	decadeOf,
	type FilterableRecord,
	facetCounts,
	matchesFilters,
	NO_FILTERS,
	toggleValue,
} from "#/lib/collection-filters";

const rec = (over: Partial<FilterableRecord> = {}): FilterableRecord => ({
	colorName: "Black",
	colorPalette: null,
	size: '12"',
	year: 1999,
	notes: null,
	...over,
});

describe("decadeOf / decadeLabel", () => {
	it("buckets years into decades", () => {
		expect(decadeOf(1987)).toBe(1980);
		expect(decadeOf(2020)).toBe(2020);
		expect(decadeOf(null)).toBeNull();
		expect(decadeOf(0)).toBeNull();
	});
	it("labels the 1900s with two digits and later decades in full", () => {
		expect(decadeLabel(1960)).toBe("60s");
		expect(decadeLabel(2010)).toBe("2010s");
	});
});

describe("matchesFilters", () => {
	it("passes everything with no filters", () => {
		expect(matchesFilters(rec(), NO_FILTERS)).toBe(true);
	});
	it("ANDs the facets together", () => {
		const r = rec({ colorName: "Red", size: '7"', year: 1984, notes: "hi" });
		expect(
			matchesFilters(r, {
				colors: ["Red"],
				sizes: ['7"'],
				decades: [1980],
				notes: true,
			}),
		).toBe(true);
		expect(matchesFilters(r, { ...NO_FILTERS, colors: ["Blue"] })).toBe(false);
		expect(matchesFilters(r, { ...NO_FILTERS, decades: [1990] })).toBe(false);
	});
	it("ORs the picks within a facet", () => {
		const eighties = rec({ year: 1984, notes: "x" });
		const nineties = rec({ year: 1995 });
		const seventies = rec({ year: 1975, notes: "x" });
		const f = { ...NO_FILTERS, decades: [1980, 1990] };
		expect(matchesFilters(eighties, f)).toBe(true);
		expect(matchesFilters(nineties, f)).toBe(true);
		expect(matchesFilters(seventies, f)).toBe(false);
		// …and still ANDs across facets.
		const both = { ...f, notes: true };
		expect(matchesFilters(eighties, both)).toBe(true);
		expect(matchesFilters(nineties, both)).toBe(false);
	});
	it("excludes records with no year once a decade is picked", () => {
		expect(
			matchesFilters(rec({ year: null }), { ...NO_FILTERS, decades: [1990] }),
		).toBe(false);
	});
	it("treats a missing colour as the default black", () => {
		expect(
			matchesFilters(rec({ colorName: null }), {
				...NO_FILTERS,
				colors: ["Black"],
			}),
		).toBe(true);
	});
	it("ignores whitespace-only notes", () => {
		expect(
			matchesFilters(rec({ notes: "  " }), { ...NO_FILTERS, notes: true }),
		).toBe(false);
	});
});

describe("toggleValue", () => {
	it("adds a missing value and removes a present one", () => {
		expect(toggleValue([1, 2], 3)).toEqual([1, 2, 3]);
		expect(toggleValue([1, 2, 3], 2)).toEqual([1, 3]);
	});
});

describe("buildFacets", () => {
	it("counts, orders, and drops one-off colours", () => {
		const facets = buildFacets([
			rec({ colorName: "Red", size: '7"', year: 1975 }),
			rec({ colorName: "Red", year: 2003, notes: "x" }),
			rec({ colorName: "Blue" }),
			rec(),
			rec(),
			rec({ size: '10"' }),
		]);
		expect(facets.colors.map((c) => [c.value, c.count])).toEqual([
			["Black", 3],
			["Red", 2],
		]);
		expect(facets.sizes.map((s) => s.value)).toEqual(['12"', '10"', '7"']);
		expect(facets.decades.map((d) => d.value)).toEqual([2000, 1990, 1970]);
		expect(facets.notes).toBe(1);
	});
	it("drops a facet that can't narrow anything", () => {
		const facets = buildFacets([rec(), rec()]);
		expect(facets.sizes).toEqual([]);
		expect(facets.decades).toEqual([]);
		expect(facets.colors).toEqual([]);
	});
});

describe("facetCounts", () => {
	const records = [
		rec({ year: 1984, notes: "x" }),
		rec({ year: 1986 }),
		rec({ year: 1995, notes: "x" }),
		rec({ year: 1972, notes: "x" }),
	];
	it("matches the plain totals with nothing picked", () => {
		const c = facetCounts(records, NO_FILTERS);
		expect([...c.decades]).toEqual([
			[1980, 2],
			[1990, 1],
			[1970, 1],
		]);
		expect(c.notes).toBe(3);
	});
	it("counts each facet against the other facets' picks only", () => {
		const c = facetCounts(records, {
			...NO_FILTERS,
			decades: [1980],
			notes: true,
		});
		// Decades: only records with notes; the 1980 pick itself doesn't narrow them.
		expect(c.decades.get(1980)).toBe(1);
		expect(c.decades.get(1990)).toBe(1);
		expect(c.decades.get(1970)).toBe(1);
		// Notes: only 80s records, regardless of the notes pick.
		expect(c.notes).toBe(1);
	});
});
