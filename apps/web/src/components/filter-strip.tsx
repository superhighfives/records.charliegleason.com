import { useMemo } from "react";
import {
	buildFacets,
	type CollectionFilters,
	type FacetCounts,
	type FilterableRecord,
	facetCounts,
	hasAnyFilter,
	NO_FILTERS,
	toggleValue,
} from "#/lib/collection-filters";
import {
	type FilterGroupId,
	type FilterSettings,
	type StripChip,
	stripGroups,
} from "#/lib/filter-settings";
import { cn } from "#/lib/utils";

/**
 * A row of filter chips under the hero. Which groups show, in what order and
 * under what heading — and which chips each offers — is configured at
 * `/admin/filters` (see `stripGroups`). Chips are independent toggles: pick
 * any number within a group (they OR together), and groups AND with each
 * other — see `matchesFilters`. Which chips exist comes from the whole
 * collection, so they don't shuffle or vanish as you click; their *counts*
 * are live — scoped to the search and the other groups' picks (see
 * `facetCounts`) — and a chip with nothing left to add dims. Scrolls sideways
 * on narrow screens rather than wrapping into a tall block.
 */
export function FilterStrip({
	records,
	countRecords,
	filters,
	settings,
	onChange,
}: {
	/** The whole collection — decides which chips exist. */
	records: FilterableRecord[];
	/** The records the counts are scoped to (the search matches). */
	countRecords: FilterableRecord[];
	filters: CollectionFilters;
	settings: FilterSettings;
	onChange: (next: CollectionFilters) => void;
}) {
	const groups = useMemo(
		() => stripGroups(buildFacets(records), settings),
		[records, settings],
	);
	const counts = useMemo(
		() => facetCounts(countRecords, filters),
		[countRecords, filters],
	);
	const active = hasAnyFilter(filters);

	if (groups.length === 0 && !active) return null;

	return (
		<nav aria-label="Filter records" className="filter-strip">
			{groups.map((group) => (
				<Group key={group.id} label={group.label}>
					{group.chips.map((chip) => (
						<Chip
							key={String(chip.value)}
							pressed={isPressed(filters, group.id, chip)}
							count={liveCount(counts, group.id, chip)}
							swatch={chip.swatch}
							onClick={() => onChange(toggle(filters, group.id, chip))}
						>
							{chip.label}
						</Chip>
					))}
				</Group>
			))}
			{active && (
				<button
					type="button"
					className="filter-clear"
					onClick={() => onChange(NO_FILTERS)}
				>
					Clear
				</button>
			)}
		</nav>
	);
}

function isPressed(
	f: CollectionFilters,
	id: FilterGroupId,
	chip: StripChip,
): boolean {
	switch (id) {
		case "decade":
			return f.decades.includes(chip.value as number);
		case "size":
			return f.sizes.includes(chip.value as string);
		case "color":
			return f.colors.includes(chip.value as string);
		case "notes":
			return f.notes;
	}
}

function liveCount(c: FacetCounts, id: FilterGroupId, chip: StripChip): number {
	switch (id) {
		case "decade":
			return c.decades.get(chip.value as number) ?? 0;
		case "size":
			return c.sizes.get(chip.value as string) ?? 0;
		case "color":
			return c.colors.get(chip.value as string) ?? 0;
		case "notes":
			return c.notes;
	}
}

function toggle(
	f: CollectionFilters,
	id: FilterGroupId,
	chip: StripChip,
): CollectionFilters {
	switch (id) {
		case "decade":
			return { ...f, decades: toggleValue(f.decades, chip.value as number) };
		case "size":
			return { ...f, sizes: toggleValue(f.sizes, chip.value as string) };
		case "color":
			return { ...f, colors: toggleValue(f.colors, chip.value as string) };
		case "notes":
			return { ...f, notes: !f.notes };
	}
}

function Group({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a labelled group of toggles, not a form fieldset
		<div role="group" aria-label={label} className="filter-group">
			<span className="kicker-muted shrink-0" aria-hidden="true">
				{label}
			</span>
			{children}
		</div>
	);
}

function Chip({
	pressed,
	count,
	swatch,
	onClick,
	children,
}: {
	pressed: boolean;
	count: number;
	swatch?: string | null;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			onClick={onClick}
			className={cn(
				"filter-chip",
				pressed && "is-pressed",
				!pressed && count === 0 && "is-empty",
			)}
		>
			{swatch && (
				<span
					aria-hidden="true"
					className="filter-swatch"
					style={{ backgroundColor: swatch }}
				/>
			)}
			{children}
			<span className="filter-count tabular-nums">{count}</span>
		</button>
	);
}
