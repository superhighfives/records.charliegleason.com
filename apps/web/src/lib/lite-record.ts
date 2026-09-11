import type { PublicRecord } from "#/lib/records";

export type LiteRecord = {
	id: number;
	artist: string;
	title: string;
	coverKey: string;
};

/**
 * Trim a public record down to the `rec` board's four fields, preferring the
 * reviewed professional shot over the raw cover. Drops records with neither
 * key — nothing for the board to render. Kept dependency-free (only a
 * type-only import from `#/lib/records`) so it can be unit tested without
 * pulling in the Workers container bindings `#/lib/records` itself needs.
 */
export function toLiteRecord(record: PublicRecord): LiteRecord | null {
	const coverKey = record.professionalImageKey ?? record.coverImageKey;
	if (coverKey == null) return null;
	return {
		id: record.id,
		artist: record.artist,
		title: record.title,
		coverKey,
	};
}
