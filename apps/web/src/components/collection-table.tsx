import { memo, useEffect, useRef } from "react";

import { FadeImage } from "#/components/fade-image";
import { SleevePlaceholder } from "#/components/sleeve-placeholder";
import { hasNotes } from "#/components/wall/tiles";
import { displayCoverKey, photoUrl } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";

/**
 * The collection as a table, one record a row: the plain alternative to the
 * wall. A row opens its record in the panel. The title is the row's button,
 * stretched over the whole row (see `.collection-table` in styles.css), so
 * the row is one click target and one tab stop.
 */
export function CollectionTable({
	records,
	onOpen,
	focusedRecordId,
}: {
	records: PublicRecord[];
	onOpen: (record: PublicRecord) => void;
	/** The record the panel has open, marked in the table. */
	focusedRecordId: number | null;
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
					<th scope="col">Title</th>
					<th scope="col">Artist</th>
					<th scope="col">Year</th>
					<th scope="col">Size</th>
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
