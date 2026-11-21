/**
 * The sleeve crop: four corners picked in the admin corner editor and stored on the
 * record (`sleeveCornersJson`). The cover is warped from exactly this quad. Kept in its
 * own dependency-free module — like `reframe-params.ts` — so both the server pipeline
 * (`professional.ts`, which pulls in `cloudflare:workers` + Photon) and the browser
 * (the corner editor and its live preview) can share the type, default and helpers
 * without dragging server-only code into the client bundle.
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
 * untrusted API input (the reframe server fn) before it drives the warp.
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

// ---------- the crop: one quad, sitting just inside the sleeve's edge ----------

/**
 * How far the crop sits inside the sleeve's true edge, as a fraction of the quad's mean
 * side. A hair inside keeps any background out of the cover's border. Snap to edges finds
 * the edge and insets the crop by this much; the default crop is the frame inset by it.
 */
export const EDGE_INSET_FRAC = 0.012;

/**
 * How far either side of the expected edge Snap to edges searches, as a fraction of the
 * quad's mean side. Wide enough for a crop dragged roughly onto the sleeve.
 */
export const EDGE_SEARCH_FRAC = 0.03;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The mean of a quad's four side lengths, in normalised units. */
export function meanSide(quad: NormalizedCorners): number {
	let side = 0;
	for (let e = 0; e < 4; e++) {
		const [ax, ay] = quad[e];
		const [bx, by] = quad[(e + 1) % 4];
		side += Math.hypot(bx - ax, by - ay);
	}
	return side / 4;
}

/** Intersection of two infinite lines (each as two points); falls back to an endpoint. */
function lineIntersect(
	a1: NormalizedCorner,
	a2: NormalizedCorner,
	b1: NormalizedCorner,
	b2: NormalizedCorner,
): NormalizedCorner {
	const d =
		(a1[0] - a2[0]) * (b1[1] - b2[1]) - (a1[1] - a2[1]) * (b1[0] - b2[0]);
	if (Math.abs(d) < 1e-9) return a2;
	const pa = a1[0] * a2[1] - a1[1] * a2[0];
	const pb = b1[0] * b2[1] - b1[1] * b2[0];
	return [
		(pa * (b1[0] - b2[0]) - (a1[0] - a2[0]) * pb) / d,
		(pa * (b1[1] - b2[1]) - (a1[1] - a2[1]) * pb) / d,
	];
}

/**
 * Offset each edge of a normalised quad by `delta` along its outward normal (positive
 * = outward), intersecting adjacent shifted lines for the new corners. A local twin of
 * photo-processing's pixel-space `offsetQuad`, kept here so this module stays
 * dependency-free (per the header note). Results are clamped to 0..1.
 */
export function offsetQuadNormalized(
	quad: NormalizedCorners,
	delta: number,
): NormalizedCorners {
	const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
	const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
	const lines: Array<[NormalizedCorner, NormalizedCorner]> = [];
	for (let e = 0; e < 4; e++) {
		const [ax, ay] = quad[e];
		const [bx, by] = quad[(e + 1) % 4];
		const ex = bx - ax;
		const ey = by - ay;
		const el = Math.hypot(ex, ey) || 1;
		let nx = -ey / el;
		let ny = ex / el;
		if ((ax + ex * 0.5 - cx) * nx + (ay + ey * 0.5 - cy) * ny < 0) {
			nx = -nx;
			ny = -ny;
		}
		lines.push([
			[ax + nx * delta, ay + ny * delta],
			[bx + nx * delta, by + ny * delta],
		]);
	}
	return [0, 1, 2, 3].map((i) => {
		const prev = lines[(i + 3) % 4];
		const cur = lines[i];
		const [x, y] = lineIntersect(prev[0], prev[1], cur[0], cur[1]);
		return [clamp01(x), clamp01(y)];
	}) as NormalizedCorners;
}

/** The crop for a sleeve whose true edge is `edge`: the edge inset by {@link EDGE_INSET_FRAC}. */
export function cropFromEdge(edge: NormalizedCorners): NormalizedCorners {
	return offsetQuadNormalized(edge, -meanSide(edge) * EDGE_INSET_FRAC);
}

/** Where the sleeve's edge is expected to be for a `crop`: the inverse of {@link cropFromEdge}. */
export function edgeFromCrop(crop: NormalizedCorners): NormalizedCorners {
	return offsetQuadNormalized(crop, meanSide(crop) * EDGE_INSET_FRAC);
}

/** The default crop: the whole frame, inset like any other crop. */
export const DEFAULT_CROP: NormalizedCorners = cropFromEdge(DEFAULT_CORNERS);

/**
 * Whether a quad is a valid crop: convex, with its corners turning the same way all
 * round. A dragged-across corner makes it self-intersecting, and the warp of that is
 * garbage, so the editor blocks Apply until it's fixed.
 */
export function isCropValid(quad: NormalizedCorners): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const [ax, ay] = quad[i];
		const [bx, by] = quad[(i + 1) % 4];
		const [cx, cy] = quad[(i + 2) % 4];
		const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
		if (cross === 0) return false;
		const s = cross > 0 ? 1 : -1;
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return true;
}

/**
 * Parse a stored `sleeveCornersJson` into the crop. Accepts a bare quad (the current
 * shape) and the older `{inner, outer}` band, whose inner quad was the crop. A band
 * converts to a bare quad the next time the record is applied. Junk or null gives
 * {@link DEFAULT_CROP}.
 */
export function parseCrop(json: string | null | undefined): NormalizedCorners {
	if (!json) return DEFAULT_CROP;
	try {
		const parsed: unknown = JSON.parse(json);
		const quad = parseNormalizedCorners(parsed);
		if (quad) return quad;
		if (typeof parsed === "object" && parsed !== null && "inner" in parsed) {
			return parseNormalizedCorners(parsed.inner) ?? DEFAULT_CROP;
		}
		return DEFAULT_CROP;
	} catch {
		return DEFAULT_CROP;
	}
}

/** Serialise a crop for storage, rounding to keep the JSON small and stable. */
export function serializeCrop(quad: NormalizedCorners): string {
	const round = (n: number) => Math.round(n * 1e4) / 1e4;
	return JSON.stringify(quad.map(([x, y]) => [round(x), round(y)]));
}

/** A pixel rectangle within an image: the region a capture is cropped to before decode. */
export interface CropBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * The pixel box around `quad` in a `width` × `height` image, padded by `margin` (a
 * fraction of each side) and clamped to the image. Whole pixels, at least 1px.
 */
export function cropBoxFor(
	quad: NormalizedCorners,
	width: number,
	height: number,
	margin: number,
): CropBox {
	const xs = quad.map(([x]) => x);
	const ys = quad.map(([, y]) => y);
	// Round off float noise first (0.8 + 0.05 is 0.8500000000000001), so an exact
	// pixel edge doesn't ceil to the next pixel.
	const px = (n: number, size: number) =>
		Math.round(Math.min(1, Math.max(0, n)) * size * 1e6) / 1e6;
	const x0 = Math.floor(px(Math.min(...xs) - margin, width));
	const y0 = Math.floor(px(Math.min(...ys) - margin, height));
	const x1 = Math.ceil(px(Math.max(...xs) + margin, width));
	const y1 = Math.ceil(px(Math.max(...ys) + margin, height));
	return {
		left: x0,
		top: y0,
		width: Math.max(1, x1 - x0),
		height: Math.max(1, y1 - y0),
	};
}

/**
 * The Images binding `trim` that crops a `width` × `height` image to `box`. `trim`
 * takes pixels to cut off each side, applied before any resize (see `trim` in
 * worker-configuration.d.ts). Only the four side cuts are used: the docs don't say
 * which side `trim.width`/`height` cut from when combined with `left`/`top`.
 */
export function trimFor(
	box: CropBox,
	width: number,
	height: number,
): { left: number; top: number; right: number; bottom: number } {
	return {
		left: box.left,
		top: box.top,
		right: width - (box.left + box.width),
		bottom: height - (box.top + box.height),
	};
}

/**
 * Re-express `quad`, normalised to a `width` × `height` image, as normalised to the
 * `box` cropped out of it. Scaling the crop afterwards keeps these the same.
 */
export function toCropCorners(
	quad: NormalizedCorners,
	box: CropBox,
	width: number,
	height: number,
): NormalizedCorners {
	const local = ([x, y]: NormalizedCorner): NormalizedCorner => [
		(x * width - box.left) / box.width,
		(y * height - box.top) / box.height,
	];
	return [local(quad[0]), local(quad[1]), local(quad[2]), local(quad[3])];
}
