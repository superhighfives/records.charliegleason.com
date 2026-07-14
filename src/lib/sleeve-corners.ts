/**
 * The sleeve's four corners, as picked in the admin corner editor and stored on the
 * record (`sleeveCornersJson`). Kept in their own dependency-free module — like
 * `reframe-params.ts` — so both the server pipeline (`professional.ts`, which pulls in
 * `cloudflare:workers` + Photon) and the browser (the corner editor + OpenCV
 * auto-detect) can share the type, default and helpers without dragging server-only
 * code into the client bundle.
 *
 * Coordinates are NORMALISED to 0..1 of the capture (so they survive the capture being
 * scaled in the editor or re-encoded), in TL, TR, BR, BL order — the same clockwise
 * order the pixel pipeline's `Corners` expects, so the server just multiplies by the
 * capture's width/height to get pixel corners for `warpToSquare`.
 */

/** A single normalised [x, y] point, each in 0..1 of the capture. */
export type NormalizedCorner = [number, number];
/** Four normalised corners in TL, TR, BR, BL order (clockwise from top-left). */
export type NormalizedCorners = [
	NormalizedCorner,
	NormalizedCorner,
	NormalizedCorner,
	NormalizedCorner,
];

/**
 * The default: the four corners of the frame. A freshly captured sleeve typically
 * fills most of the frame, so this is a sane starting crop (and the seed the admin
 * drags from). TL, TR, BR, BL.
 */
export const DEFAULT_CORNERS: NormalizedCorners = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 1],
];

/**
 * Sort any four points into TL, TR, BR, BL order. Top two by y are the top edge (the
 * lesser-x of them is TL); the bottom two are the bottom edge (lesser-x is BL). Robust
 * for a roughly-frontal quad under mild rotation — which is all a sleeve photo ever is.
 * Used to normalise the order of OpenCV's `approxPolyDP` output and of dragged handles.
 */
export function orderCorners(pts: NormalizedCorner[]): NormalizedCorners {
	if (pts.length !== 4)
		throw new Error("orderCorners expects exactly 4 points");
	const byY = [...pts].sort((a, b) => a[1] - b[1]);
	const [t1, t2] = byY.slice(0, 2).sort((a, b) => a[0] - b[0]); // top: TL, TR
	const [b1, b2] = byY.slice(2, 4).sort((a, b) => a[0] - b[0]); // bottom: BL, BR
	return [t1, t2, b2, b1];
}

/** Whether a value is a valid [x, y] with both coordinates finite and in 0..1. */
function isNormalizedCorner(v: unknown): v is NormalizedCorner {
	return (
		Array.isArray(v) &&
		v.length === 2 &&
		typeof v[0] === "number" &&
		typeof v[1] === "number" &&
		Number.isFinite(v[0]) &&
		Number.isFinite(v[1]) &&
		v[0] >= 0 &&
		v[0] <= 1 &&
		v[1] >= 0 &&
		v[1] <= 1
	);
}

/**
 * Validate an already-parsed value as {@link NormalizedCorners} — exactly four
 * finite [x,y] points in 0..1. Returns null on anything else. Used to sanitise
 * untrusted API input (the reframe/enhance server fns) before it drives the warp.
 */
export function parseNormalizedCorners(
	value: unknown,
): NormalizedCorners | null {
	return Array.isArray(value) &&
		value.length === 4 &&
		value.every(isNormalizedCorner)
		? (value as NormalizedCorners)
		: null;
}

/** Parse a stored `sleeveCornersJson` string into corners (DEFAULT on junk/null). */
export function parseCorners(
	json: string | null | undefined,
): NormalizedCorners {
	if (!json) return DEFAULT_CORNERS;
	try {
		return parseNormalizedCorners(JSON.parse(json)) ?? DEFAULT_CORNERS;
	} catch {
		return DEFAULT_CORNERS;
	}
}

/** Serialise corners for storage, rounding to keep the JSON small and stable. */
export function serializeCorners(corners: NormalizedCorners): string {
	const round = (n: number) => Math.round(n * 1e4) / 1e4;
	return JSON.stringify(corners.map(([x, y]) => [round(x), round(y)]));
}
