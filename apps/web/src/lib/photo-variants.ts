/**
 * Pre-sized copies of a professional cover, written next to the master at Apply time
 * (`professional/{uuid}.webp` → `professional/{uuid}@500.webp`, …). `/api/photos/$`
 * serves one of these directly for a matching `?w=` instead of resizing the master on
 * the fly — a cold on-the-fly resize of a multi-megabyte master measured ~0.8s per
 * cover, which across a few hundred grid tiles is most of a first visit.
 *
 * Pure (no `cloudflare:workers`) so the route, the pipeline and tests can share it.
 */

/** The widths callers actually request (grid tile, spanning tile/panel, lightbox). */
export const PRESIZED_WIDTHS = [500, 800, 1600] as const;

/** Re-encode settings — match the route's on-the-fly resize so both paths look alike. */
export const PRESIZED_QUALITY = 82;

const PREFIX = "professional/";

/** Whether `key` is a professional master that gets pre-sized copies. */
export function hasPresizedVariants(key: string): boolean {
	return key.startsWith(PREFIX) && key.endsWith(".webp") && !key.includes("@");
}

/** The R2 key of `key`'s pre-sized copy at `width`. */
export function presizedKey(key: string, width: number): string {
	return `${key.slice(0, -".webp".length)}@${width}.webp`;
}

/**
 * Every key to delete alongside a professional master — the master plus its
 * pre-sized copies (deleting a copy that was never written is a no-op in R2).
 */
export function withPresizedKeys(key: string): string[] {
	return hasPresizedVariants(key)
		? [key, ...PRESIZED_WIDTHS.map((w) => presizedKey(key, w))]
		: [key];
}
