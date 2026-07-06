import type { Record } from "#/db/schema";

/**
 * Cover-selection + public-serialisation helpers. Pure and dependency-light (only
 * the `Record` type), so both the server data layer and client components can
 * share one definition of "which image displays" and "what's safe to expose".
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

/**
 * The public record shape. Drops the admin-only iPhone capture key and the
 * internal professional-job bookkeeping (error text + Replicate prediction id),
 * while keeping `professionalImageKey`/`professionalStatus` so the public views
 * can prefer an approved studio photo.
 */
export type PublicRecord = Omit<
	Record,
	"capturePhotoKey" | "professionalError" | "professionalPredictionId"
>;

/** Strip admin-only + internal fields from a record for a public payload. */
export function toPublicRecord(record: Record): PublicRecord {
	const {
		capturePhotoKey: _capture,
		professionalError: _error,
		professionalPredictionId: _prediction,
		...rest
	} = record;
	return rest;
}
