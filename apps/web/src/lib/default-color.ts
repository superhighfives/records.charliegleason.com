/**
 * New records without an explicit color default to this chip — see
 * `records.ts`. Its own module (re-exported from `colors.ts`) so client-side
 * and pure code can use it without importing the server-only colors module.
 */
export const DEFAULT_COLOR_NAME = "Black";
