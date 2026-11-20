import type { PublicRecord } from "#/lib/records";

// A tile's narrowest width, which sets how many columns the wall lays out
// across the screen (see `columnsFor` in wall-scene.tsx).
export const TILE_MIN_PX = 180;

export function hasNotes(record: Pick<PublicRecord, "notes">): boolean {
	return Boolean(record.notes?.trim());
}

// Minimum number of plain 1×1 tiles between two 2×2 "notes" tiles — see
// `computeSpanningIds`.
const MIN_SPAN_GAP = 3;

/**
 * Which records take a 2×2 tile on the wall instead of the default 1×1.
 * Every record with notes is *eligible*, but consecutive eligible records are
 * throttled to at least `MIN_SPAN_GAP` tiles apart, so a run of back-to-back
 * notes-bearing records in the collection (common here) reads as occasional
 * feature moments rather than a wall of oversized tiles. Records skipped this
 * way still show their notes in the detail panel — this only affects the
 * tile's size.
 */
export function computeSpanningIds(records: PublicRecord[]): Set<number> {
	const spanning = new Set<number>();
	let sinceLastSpan = MIN_SPAN_GAP;
	for (const record of records) {
		if (hasNotes(record) && sinceLastSpan >= MIN_SPAN_GAP) {
			spanning.add(record.id);
			sinceLastSpan = 0;
		} else {
			sinceLastSpan++;
		}
	}
	return spanning;
}
