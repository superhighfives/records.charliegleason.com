/* tslint:disable */
/* eslint-disable */

/**
 * wasm entry point. Returns a flat length-8 `Vec<f64>` (TL,TR,BR,BL normalised) or an empty
 * vec on failure — same convention as `sleeve-detect`'s `detectSleeveCorners`.
 */
export function detectSleeveCornersNet(rgba: Uint8Array, width: number, height: number): Float64Array;
