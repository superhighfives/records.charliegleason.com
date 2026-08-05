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

/**
 * The record's alpha matte — the transparent, true-edged sleeve floating on a margin
 * with a soft shadow — for surfaces that want the object rather than the square hero
 * (the homepage grid). Like {@link displayCoverKey}, only an *approved* photo's matte
 * goes live; callers fall back to {@link displayCoverKey} when this is null.
 */
export function displayMatteKey(
	record: Pick<Record, "professionalAlphaKey" | "professionalStatus">,
): string | null {
	return record.professionalStatus === "approved" && record.professionalAlphaKey
		? record.professionalAlphaKey
		: null;
}

/**
 * A display URL for a stored photo. Masters live in R2 at full resolution (up to
 * 4096px, often ~1MB) so there's headroom to reprocess later; `width` asks
 * `/api/photos/$` to resize + re-encode to webp on the way out via the Cloudflare
 * Images binding, so a caller requests the size it actually renders at (a grid
 * tile, a lightbox) instead of shipping the master every time. Omit `width` for
 * the master itself (e.g. feeding a downstream image pipeline).
 */
export function photoUrl(key: string, width?: number): string {
	return width ? `/api/photos/${key}?w=${width}` : `/api/photos/${key}`;
}
