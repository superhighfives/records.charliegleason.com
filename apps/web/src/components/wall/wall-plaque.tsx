import { useMemo } from "react";

import { collectionStats } from "#/lib/collection-stats";
import { numberToWords } from "#/lib/number-to-words";
import type { PublicRecord } from "#/lib/records";

/**
 * `?hero=plaque`: the stats as a small museum-style wall text beside the
 * hero — a title in small caps, then a few short lines — rather than a
 * sentence. Hidden in every other mode (see `[data-hero-mode]` in
 * styles.css).
 */
export function WallPlaque({ records }: { records: PublicRecord[] }) {
	const stats = useMemo(() => collectionStats(records), [records]);
	const lines: string[] = [];
	if (stats.oldest) {
		lines.push(
			`Oldest: ${stats.oldest.title}, ${stats.oldest.artist} (${stats.oldest.year})`,
		);
	}
	if (stats.newestYear) lines.push(`Newest: ${stats.newestYear}`);
	if (stats.coloured > 0) {
		lines.push(
			`${numberToWords(stats.coloured)} on coloured vinyl${
				stats.topColour ? `, mostly ${stats.topColour.toLowerCase()}` : ""
			}`,
		);
	}
	if (stats.multiDisc > 1) {
		lines.push(`${numberToWords(stats.multiDisc)} across more than one disc`);
	}
	if (stats.topArtist) {
		lines.push(
			`Most collected: ${stats.topArtist.name} (${numberToWords(stats.topArtist.count)})`,
		);
	}
	if (stats.withNotes > 0) {
		lines.push(`${numberToWords(stats.withNotes)} with notes`);
	}
	return (
		<div className="wall-plaque">
			<p className="wall-plaque-title">
				The collection · {numberToWords(stats.total)} records
			</p>
			{lines.map((line) => (
				<p key={line}>{line.charAt(0).toUpperCase() + line.slice(1)}</p>
			))}
		</div>
	);
}
