/* tslint:disable */
/* eslint-disable */

/**
 * Detect the sleeve's four corners in an RGBA image.
 *
 * `rgba` is `width * height * 4` bytes (R,G,B,A per pixel — same layout as a canvas
 * `ImageData`/`Uint8ClampedArray`, which is what the TS caller already has in hand).
 *
 * Returns a flat `[x0,y0, x1,y1, x2,y2, x3,y3]` array of eight normalised (0..1)
 * coordinates in TL, TR, BR, BL order on success, or an empty array when no confident
 * quad was found — the TS wrapper maps that to `null`, matching the pure-TS detector's
 * return type (`NormalizedCorners | null`) so callers can't tell them apart.
 */
export function detectSleeveCorners(rgba: Uint8Array, width: number, height: number): Float64Array;

export function init(): void;
