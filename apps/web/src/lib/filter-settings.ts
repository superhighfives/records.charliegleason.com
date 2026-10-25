import { z } from "zod";

import {
	type CollectionFacets,
	decadeLabel,
	type Facet,
} from "#/lib/collection-filters";

/**
 * The admin's control over the public filter strip (`/admin/filters`): which
 * groups show, in what order, under what heading, how many records a chip
 * needs before it's offered, and individual chips to hide outright. Stored
 * as one JSON blob in `settings` under {@link FILTER_SETTINGS_KEY}. Pure, so
 * the strip and the admin preview agree on what a config means.
 */
export const FILTER_SETTINGS_KEY = "filters";

export const FILTER_GROUP_IDS = ["decade", "size", "color", "notes"] as const;
export type FilterGroupId = (typeof FILTER_GROUP_IDS)[number];

const groupSchema = z.object({
	id: z.enum(FILTER_GROUP_IDS),
	enabled: z.boolean(),
	label: z.string().trim().max(40),
	minCount: z.number().int().min(1).max(1000),
	/** Chip values to never offer, as strings (decades as "1950"). */
	hidden: z.array(z.string()).max(200),
});

export const filterSettingsSchema = z.object({
	groups: z.array(groupSchema),
});

export type FilterGroupSettings = z.infer<typeof groupSchema>;
export type FilterSettings = z.infer<typeof filterSettingsSchema>;

/**
 * What the strip did before it was configurable: decade and notes on, colour
 * and size off (nearly every record is a black 12"), colours needing two
 * records so the row isn't padded with one-offs.
 */
export const DEFAULT_FILTER_SETTINGS: FilterSettings = {
	groups: [
		{ id: "decade", enabled: true, label: "Decade", minCount: 1, hidden: [] },
		{ id: "notes", enabled: true, label: "Notes", minCount: 1, hidden: [] },
		{ id: "color", enabled: false, label: "Colour", minCount: 2, hidden: [] },
		{ id: "size", enabled: false, label: "Size", minCount: 1, hidden: [] },
	],
};

/**
 * Any stored value → a complete, valid config: invalid groups and duplicates
 * are dropped, groups the stored value doesn't know about (added since it
 * was saved) are appended with their defaults, and anything unparseable
 * falls back to {@link DEFAULT_FILTER_SETTINGS} wholesale.
 */
export function normalizeFilterSettings(raw: unknown): FilterSettings {
	const list =
		raw &&
		typeof raw === "object" &&
		Array.isArray((raw as FilterSettings).groups)
			? (raw as FilterSettings).groups
			: [];
	const seen = new Set<FilterGroupId>();
	const groups: FilterGroupSettings[] = [];
	for (const g of list) {
		const parsed = groupSchema.safeParse(g);
		if (!parsed.success || seen.has(parsed.data.id)) continue;
		seen.add(parsed.data.id);
		const fallback = defaultGroup(parsed.data.id);
		groups.push({
			...parsed.data,
			label: parsed.data.label || fallback.label,
		});
	}
	for (const g of DEFAULT_FILTER_SETTINGS.groups) {
		if (!seen.has(g.id)) groups.push({ ...g, hidden: [...g.hidden] });
	}
	return { groups };
}

function defaultGroup(id: FilterGroupId): FilterGroupSettings {
	// biome-ignore lint/style/noNonNullAssertion: every id has a default
	return DEFAULT_FILTER_SETTINGS.groups.find((g) => g.id === id)!;
}

/** A chip the strip will draw. */
export interface StripChip {
	/** The value the filter state holds (a decade is a number). */
	value: string | number;
	label: string;
	/** Records with this value across the whole collection. */
	total: number;
	swatch?: string | null;
}

export interface StripGroup {
	id: FilterGroupId;
	label: string;
	chips: StripChip[];
}

/**
 * The groups to draw, in order, with their chips: disabled groups skipped,
 * hidden chips and chips under `minCount` dropped, and a group left with a
 * single chip dropped too — one option can't narrow anything. "Has notes" is
 * a lone toggle, so it only needs `minCount` records with notes.
 */
export function stripGroups(
	facets: CollectionFacets,
	settings: FilterSettings,
): StripGroup[] {
	const out: StripGroup[] = [];
	for (const g of settings.groups) {
		if (!g.enabled) continue;
		const hidden = new Set(g.hidden);
		const keep = (f: Facet<string | number>) =>
			f.count >= g.minCount && !hidden.has(String(f.value));
		let chips: StripChip[];
		switch (g.id) {
			case "decade":
				chips = facets.decades.filter(keep).map((f) => ({
					value: f.value,
					label: decadeLabel(f.value),
					total: f.count,
				}));
				break;
			case "size":
				chips = facets.sizes
					.filter(keep)
					.map((f) => ({ value: f.value, label: f.value, total: f.count }));
				break;
			case "color":
				chips = facets.colors.filter(keep).map((f) => ({
					value: f.value,
					label: f.value,
					total: f.count,
					swatch: f.swatch,
				}));
				break;
			case "notes":
				chips =
					facets.notes >= g.minCount
						? [{ value: "notes", label: "Has notes", total: facets.notes }]
						: [];
				break;
		}
		if (g.id === "notes" ? chips.length === 0 : chips.length < 2) continue;
		out.push({ id: g.id, label: g.label, chips });
	}
	return out;
}
