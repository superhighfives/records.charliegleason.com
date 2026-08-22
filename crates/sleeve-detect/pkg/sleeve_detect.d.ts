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

/**
 * Detect the sleeve's corners AND report the segmentation's own confidence signals, so the
 * TS orchestrator (`detectSleeveCornersBest`) can *reconcile* this colour-segmentation
 * detector against the learned net on every capture rather than only reaching for it when the
 * net's wasm fails to load. That reconciliation is what lets a confident segmentation override
 * an out-of-distribution net miss — e.g. a neon-pink sleeve on tan card, which segments
 * trivially (rectangularity ~0.96) but the net has never seen, so it regresses toward a
 * frame-filling mean. See the module doc in `sleeve-detect-wasm.ts`.
 *
 * Returns a flat array, or empty when the image is too small / no blob was found at all:
 *   `[accepted, rectangularity, blob_area_frac, x0,y0, x1,y1, x2,y2, x3,y3]`
 * `accepted` is 1.0 when the fitted quad cleared every gate (so it equals what
 * `detect_sleeve_corners` returns non-empty) and 0.0 when a blob was fitted but a gate rejected
 * it. The quad (TL,TR,BR,BL normalised) is present in *both* cases — a soft-rejected fit is
 * still worth comparing against the net's geometry to gauge agreement.
 */
export function detectSleeveCornersScored(rgba: Uint8Array, width: number, height: number): Float64Array;

export function init(): void;
