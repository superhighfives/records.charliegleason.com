import { useMemo } from "react";
import {
	buildFacets,
	type CollectionFilters,
	decadeLabel,
	type FilterableRecord,
	facetCounts,
	hasAnyFilter,
	NO_FILTERS,
	toggleValue,
} from "#/lib/collection-filters";
import { cn } from "#/lib/utils";

/**
 * A row of filter chips under the hero — decade and "has notes". Chips are
 * independent toggles: pick any number of decades (they OR together), and
 * groups AND with each other — see `matchesFilters`. Which chips exist comes
 * from the whole collection, so they don't shuffle or vanish as you click;
 * their *counts* are live — scoped to the search and the other groups'
 * picks (see `facetCounts`) — and a chip with nothing left to add dims. Scrolls sideways on narrow screens
 * rather than wrapping into a tall block. Colour and size are supported by
 * the filter logic but not offered here for now — nearly every record is a
 * black 12", so neither narrows much yet.
 */
export function FilterStrip({
	records,
	countRecords,
	filters,
	onChange,
}: {
	/** The whole collection — decides which chips exist. */
	records: FilterableRecord[];
	/** The records the counts are scoped to (the search matches). */
	countRecords: FilterableRecord[];
	filters: CollectionFilters;
	onChange: (next: CollectionFilters) => void;
}) {
	const facets = useMemo(() => buildFacets(records), [records]);
	const counts = useMemo(
		() => facetCounts(countRecords, filters),
		[countRecords, filters],
	);
	const active = hasAnyFilter(filters);

	return (
		<nav aria-label="Filter records" className="filter-strip">
			{facets.decades.length > 0 && (
				<Group label="Decade">
					{facets.decades.map((d) => (
						<Chip
							key={d.value}
							pressed={filters.decades.includes(d.value)}
							count={counts.decades.get(d.value) ?? 0}
							onClick={() =>
								onChange({
									...filters,
									decades: toggleValue(filters.decades, d.value),
								})
							}
						>
							{decadeLabel(d.value)}
						</Chip>
					))}
				</Group>
			)}
			{facets.notes > 0 && (
				<Group label="Notes">
					<Chip
						pressed={filters.notes}
						count={counts.notes}
						onClick={() => onChange({ ...filters, notes: !filters.notes })}
					>
						Has notes
					</Chip>
				</Group>
			)}
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
	onClick,
	children,
}: {
	pressed: boolean;
	count: number;
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
			{children}
			<span className="filter-count tabular-nums">{count}</span>
		</button>
	);
}
