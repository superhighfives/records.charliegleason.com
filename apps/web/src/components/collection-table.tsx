import { ArrowDown, ArrowUp } from "lucide-react";
import { memo, useEffect, useRef } from "react";

import { FadeImage } from "#/components/fade-image";
import { SleevePlaceholder } from "#/components/sleeve-placeholder";
import { hasNotes } from "#/components/wall/tiles";
import type { SortColumn, TableSort } from "#/lib/collection-filters";
import { displayCoverKey, photoUrl } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";

/**
 * The collection as a table, one record a row: the plain alternative to the
 * wall. A row opens its record in the panel. The title is the row's button,
 * stretched over the whole row (see `.collection-table` in styles.css), so
 * the row is one click target and one tab stop. The column headings sort it.
 */
export function CollectionTable({
	records,
	onOpen,
	focusedRecordId,
	sort,
	onSort,
}: {
	/** Already in `sort` order (see `CollectionView`). */
	records: PublicRecord[];
	onOpen: (record: PublicRecord) => void;
	/** The record the panel has open, marked in the table. */
	focusedRecordId: number | null;
	sort: TableSort | null;
	onSort: (sort: TableSort | null) => void;
}) {
	const body = useRef<HTMLTableSectionElement>(null);
	// Paging through the panel keeps the open record's row in view: it
	// scrolls only if the row would be under the search or the bottom bar,
	// and only far enough to clear them (see the rows' `scroll-margin`).
	useEffect(() => {
		if (focusedRecordId == null) return;
		const reduce = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		body.current?.querySelector("tr[data-active]")?.scrollIntoView({
			block: "nearest",
			behavior: reduce ? "auto" : "smooth",
		});
	}, [focusedRecordId]);

	return (
		<table className="collection-table">
			<thead>
				<tr>
					<th scope="col">
						<span className="sr-only">Cover</span>
					</th>
					{SORT_COLUMNS.map(({ column, label }) => (
						<SortHeading
							key={column}
							column={column}
							label={label}
							sort={sort}
							onSort={onSort}
						/>
					))}
					<th scope="col">
						<span className="sr-only">Notes</span>
					</th>
				</tr>
			</thead>
			<tbody ref={body}>
				{records.map((record) => (
					<TableRow
						key={record.id}
						record={record}
						active={record.id === focusedRecordId}
						onOpen={onOpen}
					/>
				))}
			</tbody>
		</table>
	);
}

const SORT_COLUMNS: { column: SortColumn; label: string }[] = [
	{ column: "title", label: "Title" },
	{ column: "artist", label: "Artist" },
	{ column: "year", label: "Year" },
	{ column: "size", label: "Size" },
];

/**
 * A column heading that sorts the table. Clicks go ascending, descending,
 * then back to the collection's own order.
 */
function SortHeading({
	column,
	label,
	sort,
	onSort,
}: {
	column: SortColumn;
	label: string;
	sort: TableSort | null;
	onSort: (sort: TableSort | null) => void;
}) {
	const direction = sort?.column === column ? sort.direction : null;
	const Arrow = direction === "desc" ? ArrowDown : ArrowUp;
	return (
		<th
			scope="col"
			aria-sort={
				direction === "asc"
					? "ascending"
					: direction === "desc"
						? "descending"
						: undefined
			}
		>
			<button
				type="button"
				className="collection-table-sort"
				data-sorted={direction ? "" : undefined}
				onClick={() =>
					onSort(
						direction === "asc"
							? { column, direction: "desc" }
							: direction === "desc"
								? null
								: { column, direction: "asc" },
					)
				}
			>
				{label}
				<Arrow aria-hidden className="size-3" />
			</button>
		</th>
	);
}

/**
 * One record's row. Memoised: opening, paging and closing change only which
 * row is active, so only those two rows re-render — not all ~300, which
 * stalled the panel's slide for a few frames.
 */
const TableRow = memo(function TableRow({
	record,
	active,
	onOpen,
}: {
	record: PublicRecord;
	active: boolean;
	onOpen: (record: PublicRecord) => void;
}) {
	const cover = displayCoverKey(record);
	return (
		<tr data-active={active ? "" : undefined}>
			<td className="collection-table-cover">
				{cover ? (
					<FadeImage
						// 500, not a width tuned to this 40px box: the photo route
						// keeps a ready-made copy at 500 (any other width is resized
						// on the fly), and the record panel and the wall ask for the
						// same URL, so they share one download.
						src={photoUrl(cover, 500)}
						alt=""
						loading="lazy"
						className="size-full object-cover"
					/>
				) : (
					<SleevePlaceholder />
				)}
			</td>
			<td>
				<button
					type="button"
					data-cursor="record"
					className="collection-table-open"
					onClick={() => onOpen(record)}
				>
					{record.title ?? "Untitled"}
				</button>
			</td>
			<td className="text-muted-foreground">{record.artist}</td>
			<td className="collection-table-mono">{record.year}</td>
			<td className="collection-table-mono">{record.size}</td>
			<td>
				{hasNotes(record) && (
					<span className="collection-table-notes" title="Has notes">
						<span className="sr-only">Has notes</span>
					</span>
				)}
			</td>
		</tr>
	);
});
