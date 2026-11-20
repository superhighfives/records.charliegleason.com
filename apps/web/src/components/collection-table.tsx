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
			<tbody>
				{records.map((record) => {
					const cover = displayCoverKey(record);
					const notes = hasNotes(record);
					return (
						<tr
							key={record.id}
							data-active={record.id === focusedRecordId ? "" : undefined}
						>
							<td className="collection-table-cover">
								{cover ? (
									<FadeImage
										// Rendered at 40px: 96 covers it at 2x.
										src={photoUrl(cover, 96)}
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
								{notes && (
									<span className="collection-table-notes" title="Has notes">
										<span className="sr-only">Has notes</span>
									</span>
								)}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
