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
		const parsed = JSON.parse(json);
		// A stored band: its outer quad is the closest single-quad reading.
		const band = parseNormalizedCornerBand(parsed);
		if (band) return band.outer;
		return parseNormalizedCorners(parsed) ?? DEFAULT_CORNERS;
	} catch {
		return DEFAULT_CORNERS;
	}
}

/** Serialise corners for storage, rounding to keep the JSON small and stable. */
export function serializeCorners(corners: NormalizedCorners): string {
	const round = (n: number) => Math.round(n * 1e4) / 1e4;
	return JSON.stringify(corners.map(([x, y]) => [round(x), round(y)]));
}

// ---------- the corner band: two quads bracketing the true sleeve edge ----------

/**
 * The admin's pick as TWO quads: `outer` sits wholly on the background (everything
 * beyond it is certified background) and `inner` sits wholly on the sleeve (everything
 * within it is certified sleeve). The true physical edge lies somewhere in the band
 * between — which is exactly a matting trimap's unknown region, drawn by hand instead
 * of inferred from a single ambiguous line. The cover warps from `inner`; the matte
 * resolves the edge inside the band.
 */
export interface CornerBand {
	inner: NormalizedCorners;
	outer: NormalizedCorners;
}

// Default band half-widths (fractions of the quad's mean side) used to synthesise a
// band from a single quad — a legacy stored pick, a detect seed, or the full-frame
// default. Legacy picks sat ON the true edge, so bracket it: a hair inside for the
// certified-sleeve quad, a bit more outside for the certified-background quad.
export const BAND_IN_FRAC = 0.012;
export const BAND_OUT_FRAC = 0.018;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

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
 * dependency-free (per the header note). Results are clamped to 0..1 — an outward
 * offset at the frame edge just rides the frame, like the full-frame default does.
 */
function offsetQuadNormalized(
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

/**
 * Synthesise a {@link CornerBand} from a single quad picked on (or near) the true
 * edge: inner a hair inside it, outer a bit beyond it. The seed for legacy stored
 * picks, detect results, and the full-frame default — the admin then nudges only
 * where the automatic band is wrong.
 */
export function bandFromQuad(quad: NormalizedCorners): CornerBand {
	let side = 0;
	for (let e = 0; e < 4; e++) {
		const [ax, ay] = quad[e];
		const [bx, by] = quad[(e + 1) % 4];
		side += Math.hypot(bx - ax, by - ay);
	}
	side /= 4;
	return {
		inner: offsetQuadNormalized(quad, -side * BAND_IN_FRAC),
		outer: offsetQuadNormalized(quad, side * BAND_OUT_FRAC),
	};
}

/** The full-frame default band — outer on the frame, inner inset from it. */
export const DEFAULT_BAND: CornerBand = bandFromQuad(DEFAULT_CORNERS);

/** Is `point` inside the (convex) quad? Same sign-of-cross test the pixel code uses. */
function insideQuadNorm(
	quad: NormalizedCorners,
	x: number,
	y: number,
): boolean {
	let sign = 0;
	for (let e = 0; e < 4; e++) {
		const [ax, ay] = quad[e];
		const [bx, by] = quad[(e + 1) % 4];
		const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
		if (cross === 0) continue;
		const s = cross > 0 ? 1 : -1;
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return true;
}

/**
 * A band is valid when every inner corner lies inside the outer quad — i.e. the
 * certified-sleeve region is wholly contained by the certified-background boundary,
 * so the trimap's unknown band can't self-contradict. The editor shows a warning and
 * the Apply is blocked while this is false.
 */
export function isBandValid(band: CornerBand): boolean {
	return band.inner.every(([x, y]) => insideQuadNorm(band.outer, x, y));
}

/**
 * Validate an already-parsed value as a {@link CornerBand} — `{inner, outer}` with
 * both quads well-formed. Returns null on anything else (including a legacy plain
 * array — callers that accept legacy input go through {@link parseCornerBand}).
 */
export function parseNormalizedCornerBand(value: unknown): CornerBand | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const v = value as { inner?: unknown; outer?: unknown };
	const inner = parseNormalizedCorners(v.inner);
	const outer = parseNormalizedCorners(v.outer);
	return inner && outer ? { inner, outer } : null;
}

/**
 * Parse a stored `sleeveCornersJson` into a {@link CornerBand}. Accepts the current
 * `{inner, outer}` shape, a legacy single-quad array (synthesised into a band via
 * {@link bandFromQuad} — no re-picking needed), and junk/null (the full-frame default).
 */
export function parseCornerBand(json: string | null | undefined): CornerBand {
	if (!json) return DEFAULT_BAND;
	try {
		const parsed = JSON.parse(json);
		const band = parseNormalizedCornerBand(parsed);
		if (band) return band;
		const quad = parseNormalizedCorners(parsed);
		return quad ? bandFromQuad(quad) : DEFAULT_BAND;
	} catch {
		return DEFAULT_BAND;
	}
}

/** Serialise a band for storage, rounded like {@link serializeCorners}. */
export function serializeCornerBand(band: CornerBand): string {
	const round = (n: number) => Math.round(n * 1e4) / 1e4;
	const q = (quad: NormalizedCorners) =>
		quad.map(([x, y]) => [round(x), round(y)]);
	return JSON.stringify({ inner: q(band.inner), outer: q(band.outer) });
}
