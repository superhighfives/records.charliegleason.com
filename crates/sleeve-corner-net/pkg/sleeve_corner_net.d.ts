/* tslint:disable */
/* eslint-disable */

/**
 * wasm entry point. Returns a flat `Vec<f64>`: the 8 normalised corners (TL,TR,BR,BL), followed
 * by 4 per-corner uncertainties (sigma) **when the model reports them** — so length is 8 for a
 * legacy model and 12 for a heteroscedastic one. Empty vec on failure. Same empty-on-failure
 * convention as `sleeve-detect`'s `detectSleeveCorners`.
 */
export function detectSleeveCornersNet(rgba: Uint8Array, width: number, height: number): Float64Array;
