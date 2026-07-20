/**
 * Canonical URL helpers for a public record. The open record lives in the path
 * as `/records/<id>-<title-slug>` (e.g. `/records/293-the-moon-and-antarctica`).
 * The numeric id is the source of truth; the slug is decorative, so a missing or
 * stale slug just canonicalises via redirect (see src/routes/records.$id.tsx).
 */

/** Slugify a record title: lowercase, `&`→"and", diacritics stripped, dash-joined. */
export function slugifyTitle(title: string | null | undefined): string {
	return (title ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // strip combining diacritics
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** The `$id` path param for a record: `293-the-moon-and-antarctica` (slug optional). */
export function recordIdParam(r: { id: number; title: string | null }): string {
	const slug = slugifyTitle(r.title);
	return slug ? `${r.id}-${slug}` : String(r.id);
}

/** Absolute-from-root path to a record's page. */
export function recordPath(r: { id: number; title: string | null }): string {
	return `/records/${recordIdParam(r)}`;
}

/**
 * Pull the leading numeric id out of a `$id` param (`293-anything` → 293).
 * Returns null when the param doesn't start with a positive integer.
 */
export function parseRecordIdParam(param: string): number | null {
	const m = param.match(/^(\d+)/);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isInteger(n) && n > 0 ? n : null;
}
