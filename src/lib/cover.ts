import type { Record } from "#/db/schema";

/**
 * Cover-selection helper. Pure and dependency-light (only the `Record` type), so
 * both the server data layer and client components share one definition of "which
 * image displays". (Public serialisation — `toPublicRecord`/`PublicRecord` — lives
 * in `#/lib/records` alongside the rest of the admin-only field policy.)
 */

/**
 * Which stored image a record should display, best-first: an *approved*
 * professional studio photo wins, then the Discogs-sourced cover, then (admin
 * views only) the raw iPhone capture. The professional photo is preferred only
 * once it's been reviewed and approved — a merely `ready` one keeps showing the
 * Discogs cover, so an unreviewed generation never goes live on the site.
 */
export function displayCoverKey(
	record: Pick<
		Record,
		"professionalImageKey" | "professionalStatus" | "coverImageKey"
	> & { capturePhotoKey?: string | null },
	opts: { includeCapture?: boolean } = {},
): string | null {
	if (record.professionalStatus === "approved" && record.professionalImageKey) {
		return record.professionalImageKey;
	}
	if (record.coverImageKey) return record.coverImageKey;
	if (opts.includeCapture && record.capturePhotoKey) {
		return record.capturePhotoKey;
	}
	return null;
}
