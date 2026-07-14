import type { Record } from "#/db/schema";

/**
 * Cover-selection helper. Pure and dependency-light (only the `Record` type), so
 * both the server data layer and client components share one definition of "which
 * image displays". (Public serialisation — `toPublicRecord`/`PublicRecord` — lives
 * in `#/lib/records` alongside the rest of the admin-only field policy.)
 */

/**
 * Which stored image a record displays. The *approved* professional studio photo
 * is the only thing shown publicly — a merely `ready` one never goes live, and the
 * Discogs-sourced cover is reference data (shown only in the admin's Discogs
 * section), never the displayed image. So the public site shows the approved photo
 * or nothing (a placeholder).
 *
 * `includeCapture` (admin views only) falls back to the raw iPhone capture when
 * there's no approved photo, so the admin still sees the record it's working on.
 * `preferCapture` is accepted for call-site compatibility but no longer changes the
 * result — capture is now the only non-professional fallback.
 */
export function displayCoverKey(
	record: Pick<Record, "professionalImageKey" | "professionalStatus"> & {
		capturePhotoKey?: string | null;
	},
	opts: { includeCapture?: boolean; preferCapture?: boolean } = {},
): string | null {
	if (record.professionalStatus === "approved" && record.professionalImageKey) {
		return record.professionalImageKey;
	}
	if (opts.includeCapture && record.capturePhotoKey) {
		return record.capturePhotoKey;
	}
	return null;
}
