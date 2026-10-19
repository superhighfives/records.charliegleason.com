import { parseColorPalette } from "#/lib/color-palette";
import { DEFAULT_COLOR_NAME } from "#/lib/default-color";

/**
 * The collection page's filter strip: any number of picks per facet. Picks
 * within a facet combine with OR (10" *or* 7"), facets combine with AND
 * ((10" or 7") *and* 80s), and the whole lot ANDs with the text search. An
 * empty facet doesn't filter at all. Pure functions over the public record
 * list, so the strip and the grid always agree on what a filter means.
 */
export interface CollectionFilters {
	colors: string[];
	sizes: string[];
	decades: number[];
	notes: boolean;
}

export const NO_FILTERS: CollectionFilters = {
	colors: [],
	sizes: [],
	decades: [],
	notes: false,
};

/** `list` with `value` added, or removed if it was already there. */
export function toggleValue<T>(list: T[], value: T): T[] {
	return list.includes(value)
		? list.filter((v) => v !== value)
		: [...list, value];
}

/** The subset of a record the filters look at. */
export interface FilterableRecord {
	colorName: string | null;
	colorPalette: string | null;
	size: string | null;
	year: number | null;
	notes: string | null;
}

export function hasAnyFilter(f: CollectionFilters): boolean {
	return (
		f.colors.length > 0 || f.sizes.length > 0 || f.decades.length > 0 || f.notes
	);
}

/** 1987 → 1980. */
export function decadeOf(year: number | null | undefined): number | null {
	return year == null || year <= 0 ? null : Math.floor(year / 10) * 10;
}

/** 1980 → "80s", 2010 → "2010s" (two-digit only for the 1900s). */
export function decadeLabel(decade: number): string {
	return decade < 2000 ? `${String(decade).slice(2)}s` : `${decade}s`;
}

export function matchesFilters(
	record: FilterableRecord,
	f: CollectionFilters,
): boolean {
	if (
		f.colors.length > 0 &&
		!f.colors.includes(record.colorName ?? DEFAULT_COLOR_NAME)
	)
		return false;
	if (f.sizes.length > 0 && !(record.size && f.sizes.includes(record.size)))
		return false;
	if (f.decades.length > 0) {
		const decade = decadeOf(record.year);
		if (decade == null || !f.decades.includes(decade)) return false;
	}
	if (f.notes && !record.notes?.trim()) return false;
	return true;
}

export interface Facet<T> {
	value: T;
	count: number;
}

export interface ColorFacet extends Facet<string> {
	/** A hex to draw the chip's swatch with, if the colour has a palette. */
	swatch: string | null;
}

export interface CollectionFacets {
	colors: ColorFacet[];
	sizes: Facet<string>[];
	decades: Facet<number>[];
	notes: number;
}

const SIZE_ORDER = ['12"', '10"', '7"'];

/**
 * What the strip can offer, with counts: colours by popularity (each needs
 * at least two records, so the row isn't padded with one-offs), sizes
 * largest first, decades newest first. A facet with only one value (say,
 * every record is a 12") is dropped — a filter that can't narrow anything
 * is just noise.
 */
export function buildFacets(records: FilterableRecord[]): CollectionFacets {
	const colors = new Map<string, ColorFacet>();
	const sizes = new Map<string, number>();
	const decades = new Map<number, number>();
	let notes = 0;
	for (const r of records) {
		const name = r.colorName ?? DEFAULT_COLOR_NAME;
		const existing = colors.get(name);
		if (existing) existing.count++;
		else
			colors.set(name, {
				value: name,
				count: 1,
				swatch:
					name === DEFAULT_COLOR_NAME
						? null
						: (parseColorPalette(r.colorPalette)?.dominant ?? null),
			});
		if (r.size) sizes.set(r.size, (sizes.get(r.size) ?? 0) + 1);
		const decade = decadeOf(r.year);
		if (decade != null) decades.set(decade, (decades.get(decade) ?? 0) + 1);
		if (r.notes?.trim()) notes++;
	}
	const colorList = [...colors.values()]
		.filter((c) => c.count >= 2)
		.sort((a, b) => b.count - a.count);
	const sizeList = [...sizes]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => sizeRank(a.value) - sizeRank(b.value));
	const decadeList = [...decades]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.value - a.value);
	return {
		colors: colorList.length > 1 ? colorList : [],
		sizes: sizeList.length > 1 ? sizeList : [],
		decades: decadeList.length > 1 ? decadeList : [],
		notes,
	};
}

function sizeRank(size: string): number {
	const i = SIZE_ORDER.indexOf(size);
	return i === -1 ? SIZE_ORDER.length : i;
}

export interface FacetCounts {
	colors: Map<string, number>;
	sizes: Map<string, number>;
	decades: Map<number, number>;
	notes: number;
}

/**
 * Live counts for the strip's chips, given the current picks: each facet is
 * counted against `records` filtered by every *other* facet, never its own.
 * So with "has notes" on, a decade chip says how many records with notes
 * are from that decade; and because picks within a facet OR together, a
 * decade chip's count is exactly what selecting it would add, whether or
 * not other decades are already picked. Pass the search-matched records so
 * the counts respect the search box too.
 */
export function facetCounts(
	records: FilterableRecord[],
	f: CollectionFilters,
): FacetCounts {
	const colors = new Map<string, number>();
	const sizes = new Map<string, number>();
	const decades = new Map<number, number>();
	let notes = 0;
	const withoutColors = { ...f, colors: [] };
	const withoutSizes = { ...f, sizes: [] };
	const withoutDecades = { ...f, decades: [] };
	const withoutNotes = { ...f, notes: false };
	for (const r of records) {
		if (matchesFilters(r, withoutColors)) {
			const name = r.colorName ?? DEFAULT_COLOR_NAME;
			colors.set(name, (colors.get(name) ?? 0) + 1);
		}
		if (r.size && matchesFilters(r, withoutSizes))
			sizes.set(r.size, (sizes.get(r.size) ?? 0) + 1);
		const decade = decadeOf(r.year);
		if (decade != null && matchesFilters(r, withoutDecades))
			decades.set(decade, (decades.get(decade) ?? 0) + 1);
		if (r.notes?.trim() && matchesFilters(r, withoutNotes)) notes++;
	}
	return { colors, sizes, decades, notes };
}
