/**
 * Deterministic pixel math for the professional-photo pipeline: turn a rough
 * capture into a straight-on, cropped, evenly-toned square — without a generative
 * model repainting anything. Everything here is pure and operates on plain RGBA
 * buffers ({@link RgbaImage}), so it's trivially unit-testable and has no runtime
 * dependency (the caller decodes/encodes via Photon + the Images binding).
 *
 * The geometry is a classic "document scanner" 4-point perspective correction: the
 * sleeve's four corners (picked by hand in the admin editor, seeded by the lightweight
 * {@link detectSleeveCorners}) are mapped onto a square via a homography and
 * inverse-sampled, which crops, squares and de-keystones in one step. The tone is a
 * foreground-aware auto-levels + white-patch white balance, so a dark capture and a
 * bright one come out consistent and neutral without desaturating the artwork.
 */

import type { NormalizedCorner, NormalizedCorners } from "#/lib/sleeve-corners";

export interface RgbaImage {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

/** A corner as [x, y] in pixel coordinates. */
export type Corner = [number, number];
/** Four corners in TL, TR, BR, BL order (clockwise from top-left). */
export type Corners = [Corner, Corner, Corner, Corner];

/** Scale normalised (0..1) corners up to pixel coordinates for a `w`×`h` image. */
export function toPixelCorners(
	corners: NormalizedCorners,
	w: number,
	h: number,
): Corners {
	return corners.map(([x, y]) => [x * (w - 1), y * (h - 1)]) as Corners;
}

// ---------- linear algebra (just enough for a homography) ----------

/** Solve an 8x8 linear system by Gaussian elimination with partial pivoting. */
function solve8(A: number[][], b: number[]): number[] {
	const n = 8;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < n; col++) {
		let piv = col;
		for (let r = col + 1; r < n; r++)
			if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
		[M[col], M[piv]] = [M[piv], M[col]];
		const d = M[col][col];
		if (Math.abs(d) < 1e-12) throw new Error("degenerate homography");
		for (let c = col; c <= n; c++) M[col][c] /= d;
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = M[r][col];
			for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
		}
	}
	return M.map((row) => row[n]);
}

/**
 * The 3x3 homography mapping the four `dst` points to the four `src` points (both
 * in TL,TR,BR,BL order). Used to inverse-sample: pass the output square as `dst`
 * and the detected sleeve corners as `src`, so each output pixel reads its source.
 */
export function homography(dst: Corners, src: Corners): number[] {
	const A: number[][] = [];
	const b: number[] = [];
	for (let i = 0; i < 4; i++) {
		const [x, y] = dst[i];
		const [X, Y] = src[i];
		A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
		b.push(X);
		A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
		b.push(Y);
	}
	const h = solve8(A, b);
	return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Apply a 3x3 homography to a point, de-homogenising the result. */
function applyH(H: number[], x: number, y: number): [number, number] {
	const w = H[6] * x + H[7] * y + H[8];
	return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Bilinear RGBA sample at floating (sx,sy); transparent black outside bounds. */
function sampleBilinear(
	img: RgbaImage,
	sx: number,
	sy: number,
	out: [number, number, number, number],
): void {
	const { data, width, height } = img;
	if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) {
		out[0] = out[1] = out[2] = out[3] = 0;
		return;
	}
	const x0 = Math.floor(sx);
	const y0 = Math.floor(sy);
	const x1 = Math.min(x0 + 1, width - 1);
	const y1 = Math.min(y0 + 1, height - 1);
	const fx = sx - x0;
	const fy = sy - y0;
	for (let c = 0; c < 4; c++) {
		const p00 = data[(y0 * width + x0) * 4 + c];
		const p10 = data[(y0 * width + x1) * 4 + c];
		const p01 = data[(y1 * width + x0) * 4 + c];
		const p11 = data[(y1 * width + x1) * 4 + c];
		const top = p00 + (p10 - p00) * fx;
		const bot = p01 + (p11 - p01) * fx;
		out[c] = top + (bot - top) * fy;
	}
}

/**
 * Warp `src` so its `srcCorners` (TL,TR,BR,BL) land on `dstCorners` in a `outW` x
 * `outH` output, inverse-mapped with bilinear sampling (no holes). Output pixels
 * whose source falls outside `src` read transparent black (via {@link
 * sampleBilinear}). The general quad-to-quad primitive under {@link warpToSquare}
 * (which squares the sleeve) and the matte's mild deskew (which keeps its shape).
 */
export function warpToQuad(
	src: RgbaImage,
	srcCorners: Corners,
	dstCorners: Corners,
	outW: number,
	outH: number,
): RgbaImage {
	const H = homography(dstCorners, srcCorners); // output -> source
	const data = new Uint8ClampedArray(outW * outH * 4);
	const px: [number, number, number, number] = [0, 0, 0, 0];
	for (let y = 0; y < outH; y++) {
		for (let x = 0; x < outW; x++) {
			const [sx, sy] = applyH(H, x, y);
			sampleBilinear(src, sx, sy, px);
			const i = (y * outW + x) * 4;
			data[i] = px[0];
			data[i + 1] = px[1];
			data[i + 2] = px[2];
			data[i + 3] = px[3];
		}
	}
	return { data, width: outW, height: outH };
}

/**
 * Warp `src` so its four `corners` (TL,TR,BR,BL) map onto a `size` x `size` output
 * square, inverse-mapped with bilinear sampling (no holes). An axis-aligned
 * rectangle passed as `corners` degrades this to a plain crop-and-scale — which is
 * exactly the no-perspective fallback, so the two paths share one implementation.
 */
export function warpToSquare(
	src: RgbaImage,
	corners: Corners,
	size: number,
): RgbaImage {
	return warpToQuad(
		src,
		corners,
		[
			[0, 0],
			[size - 1, 0],
			[size - 1, size - 1],
			[0, size - 1],
		],
		size,
		size,
	);
}

// ---------- sleeve detection (best-effort seed) ----------

/** Median of a numeric array (mutates by sorting a copy); NaN for an empty array. */
function median(xs: number[]): number {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Robustly fit a line `v = a·u + b` to `[u, v]` points via Theil–Sen: the slope is the
 * median of pairwise slopes and the intercept the median of `v − a·u`. Unlike least
 * squares it shrugs off the scattered outliers a per-scanline edge search throws off
 * (an occluded border, an internal artwork edge that briefly out-gradients the true one),
 * which is exactly what {@link detectSleeveCorners} needs. `null` if under two points or
 * every point shares one `u` (a vertical set in this parametrisation — no defined slope).
 */
function theilSen(
	points: Array<[number, number]>,
): { a: number; b: number } | null {
	if (points.length < 2) return null;
	const slopes: number[] = [];
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			const du = points[j][0] - points[i][0];
			if (du === 0) continue;
			slopes.push((points[j][1] - points[i][1]) / du);
		}
	}
	if (slopes.length === 0) return null;
	const a = median(slopes);
	const b = median(points.map(([u, v]) => v - a * u));
	return { a, b };
}

/**
 * Evenly thin `arr` down to at most `max` items (deterministically — same input, same
 * output, so tests stay stable). Theil–Sen is O(n²) in the point count, so this caps the
 * work per side: a well-spread subsample of a few hundred edge points fits the same line
 * as every scanline would, and the median-of-slopes robustness doesn't need the rest.
 */
function subsample<T>(arr: T[], max: number): T[] {
	if (arr.length <= max) return arr;
	const out: T[] = [];
	for (let i = 0; i < max; i++)
		out.push(arr[Math.floor((i * arr.length) / max)]);
	return out;
}

/**
 * Best-effort seed for the corner editor: find the sleeve's four corners so a freshly
 * captured record opens roughly pre-cropped. Returns normalised corners (TL,TR,BR,BL,
 * 0..1), or `null` for a degenerate result — the caller then falls back to the full-frame
 * default and the admin drags the handles by hand.
 *
 * Unlike the old scalar-per-side version this fits a real QUADRILATERAL, so a sleeve shot
 * at a slight angle (rotated on the table, or keystoned by a tilted phone) opens correctly
 * de-skewed instead of boxed by an axis-aligned rectangle — the homography warp downstream
 * already handles an arbitrary quad.
 *
 * Works off EDGES, not colour: the sleeve sits on a background and nearly fills the frame,
 * so its four straight borders are the strongest luminance transitions near the frame. For
 * each side we scan inward from the frame within an outer band and, on every scanline,
 * compare a small reference window at each end of the band — for the left/top sides that's
 * background-vs-sleeve, but the right/bottom bands are scanned with `lo`/`hi` reversed, so
 * there it's sleeve-vs-background; the crossing-finder is symmetric and direction-agnostic,
 * so which physical thing sits at which end doesn't matter — that overall contrast, not a
 * single-pixel derivative, is the scanline's confidence, so a boundary blurred across many
 * samples (a soft shadow under the
 * sleeve, an out-of-focus edge) registers just as strongly as a hard one-pixel step. The
 * edge point itself is taken as the sample closest to the midpoint between those two
 * reference luminances — the middle of the transition, however wide it is. A robust
 * Theil–Sen line fit through those points gives that side's line; because each side is
 * fitted independently the result can tilt and keystone. The robust fit and a per-side
 * contrast threshold reject scanlines where the border is worn/occluded or an internal
 * artwork edge (a tree, a horizon) briefly wins, and the outer-band limit keeps the search
 * off deep internal edges entirely. Intersecting the four fitted lines yields the corners.
 * Pure and bounded — strided sampling plus a cap on the points fed to the O(n²) line fit
 * (see `MAX_FIT_POINTS`) — so it runs on the Worker straight off the capture we already
 * decode for the reframe.
 */
export function detectSleeveCorners(img: RgbaImage): NormalizedCorners | null {
	const { data, width, height } = img;
	if (width < 40 || height < 40) return null;

	// Sample on a stride so this stays cheap on a full-res capture (~400 per axis).
	const stride = Math.max(1, Math.round(Math.min(width, height) / 400));
	const lum = (x: number, y: number) => {
		const i = (y * width + x) * 4;
		return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
	};

	// Fraction of each axis searched inward from the frame for that side's border. Wider
	// than a straight box would need so a tilted edge — closer to the frame at one end,
	// further at the other — stays within the search band along its whole length.
	const BAND = 0.18;
	// Keep a scanline's edge pick only if its gradient is at least this fraction of the
	// strongest pick on that side. Drops flat/occluded scanlines and weak internal-artwork
	// picks before the fit, so a handful of strong true-edge points aren't outvoted.
	const KEEP_FRAC = 0.35;
	// A side must yield edge picks on at least this fraction of its scanlines, else the fit
	// isn't trustworthy and we bail to the full-frame default.
	const MIN_INLIER_FRAC = 0.3;
	// Cap on the edge points handed to the O(n²) Theil–Sen fit per side. Bounds the cost on
	// tall/wide captures (where the scanline count runs into the thousands) to a few hundred
	// well-spread points, which fit the same line. The inlier check below still runs on the
	// full count, so thinning for the fit doesn't weaken the confidence gate.
	const MAX_FIT_POINTS = 256;

	// Number of stride-steps averaged at each end of the band to estimate the two reference
	// luminances for a scanline (background and sleeve, order depends on scan direction —
	// see `collect`) — smooths out single-sample noise (paper texture) without needing the
	// boundary between them to be a sharp step.
	const REF = 3;
	// Consecutive stride-steps required on the inner side of the midpoint before a crossing
	// counts, so one noisy background sample (paper texture) isn't mistaken for the edge.
	const CONFIRM = 3;
	const sampleLum = (vertical: boolean, u: number, v: number) =>
		vertical ? lum(v, u) : lum(u, v);

	// Collect one edge point per scanline for a side, keeping only confident picks. For a
	// vertical side (left/right) we walk rows and scan x across [lo,hi); points are [y, x]
	// to fit x = a·y + b. For a horizontal side we walk columns and scan y; points are
	// [x, y] to fit y = a·x + b. `n` is the scanline count, for the inlier check.
	const collect = (
		vertical: boolean,
		lo: number,
		hi: number,
	): { points: Array<[number, number]>; n: number } => {
		const along = vertical ? height : width;
		const raw: Array<[number, number, number]> = []; // [u, v, contrast]
		let maxContrast = 0;
		// Snap the scan start/end onto the stride grid so `v` stays an integer. Neither
		// `lo` (`size * BAND`) nor `hi` (`size * (1 - BAND)`) is reliably a whole number, and
		// a fractional index into the RGBA buffer reads back as `undefined` → NaN — which
		// silently zeroes the search for whichever side that lands on and bails the whole
		// detector to null on any capture whose size doesn't happen to align.
		const vStart = Math.max(stride, Math.ceil(lo / stride) * stride);
		const vEnd = Math.floor(hi) - 1;
		for (let u = 0; u < along; u += stride) {
			let outerSum = 0;
			let outerN = 0;
			let innerSum = 0;
			let innerN = 0;
			for (let k = 0; k < REF; k++) {
				const vo = vStart + k * stride;
				if (vo < hi) {
					outerSum += sampleLum(vertical, u, vo);
					outerN++;
				}
				const vi = vEnd - k * stride;
				if (vi >= vStart) {
					innerSum += sampleLum(vertical, u, vi);
					innerN++;
				}
			}
			if (outerN === 0 || innerN === 0) continue;
			const outerLum = outerSum / outerN;
			const innerLum = innerSum / innerN;
			const contrast = Math.abs(innerLum - outerLum);
			const mid = (outerLum + innerLum) / 2;
			const rising = innerLum >= outerLum;

			// The edge point is the first sample past `vStart` that crosses the midpoint
			// between the two reference luminances and *stays* on the inner side for
			// `CONFIRM` samples running — the middle of the transition, whether it's a hard
			// one-pixel step (which never actually samples the midpoint value, so "closest
			// sample" would be a coin flip between the two plateaus) or spread across many
			// (a shadow, an out-of-focus boundary). Requiring a sustained run, not just the
			// first sample past the midpoint, keeps a single noisy background sample (paper
			// texture) from being mistaken for the crossing.
			let bestV = -1;
			let sawOuterSide = false;
			let run = 0;
			for (let v = vStart; v < hi; v += stride) {
				const s = sampleLum(vertical, u, v);
				const isInnerSide = rising ? s > mid : s < mid;
				if (!isInnerSide) {
					sawOuterSide = true;
					run = 0;
					continue;
				}
				if (!sawOuterSide) continue;
				if (run === 0) bestV = v;
				run++;
				if (run >= CONFIRM) break;
			}
			if (run < CONFIRM) bestV = -1;
			if (bestV >= 0) {
				raw.push([u, bestV, contrast]);
				if (contrast > maxContrast) maxContrast = contrast;
			}
		}
		const cutoff = maxContrast * KEEP_FRAC;
		const points = raw
			.filter(([, , g]) => g >= cutoff)
			.map(([u, v]) => [u, v] as [number, number]);
		return { points, n: Math.ceil(along / stride) };
	};

	const leftS = collect(true, 0, width * BAND);
	const rightS = collect(true, width * (1 - BAND), width);
	const topS = collect(false, 0, height * BAND);
	const bottomS = collect(false, height * (1 - BAND), height);

	// Every side needs enough confident picks, or we don't trust the quad.
	for (const s of [leftS, rightS, topS, bottomS]) {
		if (s.points.length < Math.max(4, s.n * MIN_INLIER_FRAC)) return null;
	}

	// Thin each side to a bounded, well-spread subset for the O(n²) fit — the inlier check
	// above already vetted the full point count.
	const left = theilSen(subsample(leftS.points, MAX_FIT_POINTS));
	const right = theilSen(subsample(rightS.points, MAX_FIT_POINTS));
	const top = theilSen(subsample(topS.points, MAX_FIT_POINTS));
	const bottom = theilSen(subsample(bottomS.points, MAX_FIT_POINTS));
	if (!left || !right || !top || !bottom) return null;

	// Two points on each fitted line, in pixel space. Vertical sides are x = a·y + b
	// (sampled at y = 0 and y = height-1); horizontal sides are y = a·x + b.
	const H = height - 1;
	const W = width - 1;
	const vLine = (l: { a: number; b: number }): [Corner, Corner] => [
		[l.b, 0],
		[l.a * H + l.b, H],
	];
	const hLine = (l: { a: number; b: number }): [Corner, Corner] => [
		[0, l.b],
		[W, l.a * W + l.b],
	];
	const [lp1, lp2] = vLine(left);
	const [rp1, rp2] = vLine(right);
	const [tp1, tp2] = hLine(top);
	const [bp1, bp2] = hLine(bottom);

	// Adjacent sides intersect at the corners: left∩top = TL, and so on clockwise.
	const tl = lineIntersect(lp1, lp2, tp1, tp2);
	const tr = lineIntersect(rp1, rp2, tp1, tp2);
	const br = lineIntersect(rp1, rp2, bp1, bp2);
	const bl = lineIntersect(lp1, lp2, bp1, bp2);

	const norm = (p: Corner): NormalizedCorner => [
		Math.min(1, Math.max(0, p[0] / W)),
		Math.min(1, Math.max(0, p[1] / H)),
	];
	const corners: NormalizedCorners = [norm(tl), norm(tr), norm(br), norm(bl)];

	// Reject an implausible quad: collapsed onto too small a region, or with corners out of
	// clockwise order (a broken fit crossing the sides) — not a confident detection.
	const xs = corners.map(([x]) => x);
	const ys = corners.map(([, y]) => y);
	if (Math.max(...xs) - Math.min(...xs) < 0.4) return null;
	if (Math.max(...ys) - Math.min(...ys) < 0.4) return null;
	const [TL, TR, BR, BL] = corners;
	if (TL[0] >= TR[0] || BL[0] >= BR[0]) return null; // top/bottom edges not left→right
	if (TL[1] >= BL[1] || TR[1] >= BR[1]) return null; // left/right edges not top→bottom

	return corners;
}

// ---------- framing ----------

/** Centre `content` on a transparent `canvasSize` square, leaving an even margin. */
export function padToCanvas(content: RgbaImage, canvasSize: number): RgbaImage {
	const data = new Uint8ClampedArray(canvasSize * canvasSize * 4);
	const offX = Math.round((canvasSize - content.width) / 2);
	const offY = Math.round((canvasSize - content.height) / 2);
	for (let y = 0; y < content.height; y++) {
		const dy = y + offY;
		if (dy < 0 || dy >= canvasSize) continue;
		for (let x = 0; x < content.width; x++) {
			const dx = x + offX;
			if (dx < 0 || dx >= canvasSize) continue;
			const s = (y * content.width + x) * 4;
			const d = (dy * canvasSize + dx) * 4;
			data[d] = content.data[s];
			data[d + 1] = content.data[s + 1];
			data[d + 2] = content.data[s + 2];
			data[d + 3] = content.data[s + 3];
		}
	}
	return { data, width: canvasSize, height: canvasSize };
}

// ---------- tone: auto-levels + white-patch white balance ----------

interface ForegroundStats {
	hist: [Uint32Array, Uint32Array, Uint32Array];
	/** Luminance histogram — drives the hue-preserving levels stretch. */
	lumaHist: Uint32Array;
	mean: [number, number, number];
	n: number;
}

/** Per-channel + luma histograms and per-channel means over opaque (foreground) pixels only. */
function foregroundStats(img: RgbaImage, alphaMin: number): ForegroundStats {
	const { data, width, height } = img;
	const hist: [Uint32Array, Uint32Array, Uint32Array] = [
		new Uint32Array(256),
		new Uint32Array(256),
		new Uint32Array(256),
	];
	const lumaHist = new Uint32Array(256);
	const sum: [number, number, number] = [0, 0, 0];
	let n = 0;
	for (let p = 0; p < width * height; p++) {
		if (data[p * 4 + 3] < alphaMin) continue;
		n++;
		const r = data[p * 4];
		const g = data[p * 4 + 1];
		const b = data[p * 4 + 2];
		hist[0][r]++;
		hist[1][g]++;
		hist[2][b]++;
		sum[0] += r;
		sum[1] += g;
		sum[2] += b;
		lumaHist[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
	}
	return {
		hist,
		lumaHist,
		mean: [
			sum[0] / Math.max(n, 1),
			sum[1] / Math.max(n, 1),
			sum[2] / Math.max(n, 1),
		],
		n,
	};
}

/** Value at the given cumulative percentile of a 256-bin histogram. */
function percentile(hist: Uint32Array, n: number, frac: number): number {
	let acc = 0;
	const target = n * frac;
	for (let v = 0; v < 256; v++) {
		acc += hist[v];
		if (acc >= target) return v;
	}
	return 255;
}

export interface AutoToneOptions {
	alphaMin?: number;
	/** Low/high percentiles (of the luma histogram) clipped to black/white when stretching levels. */
	lowPct?: number;
	highPct?: number;
	/** 0 = no white balance, 1 = full white-patch correction. */
	wbStrength?: number;
	/** Target normalised mean luma after levels (0..1); drives one global gamma. */
	targetMid?: number;
}

/** Percentile of each channel treated as the near-white reference for white-balance. */
const WB_WHITE_PCT = 0.97;

/**
 * Below this brightness (0..255) the 97th-percentile "near-white" sample isn't
 * actually white — on a dark, low-key cover (e.g. a mostly-black sleeve with no true
 * highlight) it's just whatever pixels happen to be brightest, often with a small,
 * meaningless per-channel imbalance. Trusting it as a white reference forces that
 * noise to neutral and pushes the *whole* frame the opposite direction; skip white
 * balance below this floor instead of correcting a cast that was never really there.
 */
const WB_MIN_REF_BRIGHTNESS = 140;
/** Below this mean foreground luma (0..255) the frame is too dark overall for a
 * reliable white-patch read; damp white balance further even if a single channel's
 * percentile clears {@link WB_MIN_REF_BRIGHTNESS}. */
const WB_MIN_MEAN_LUMA = 60;
/**
 * A genuine white point is close to neutral by definition — if the "near-white"
 * sample's channels are already this far apart (as a fraction of the brightest
 * channel), it isn't white, it's just whatever's brightest, and its spread is real
 * image colour rather than an ambient cast. Trusting it as a reference doesn't just
 * shift hue slightly: the subsequent exposure-lift gamma (steep on a dark frame) can
 * blow a small, spurious per-channel gain gap into a strong, visible tint across the
 * whole image. Trust fades to zero by twice this fraction.
 */
const WB_MAX_NEUTRAL_SPREAD = 0.12;

export interface AutoToneResult extends RgbaImage {
	debug: {
		wbGain: [number, number, number];
		lo: number[];
		hi: number[];
		gamma: number;
		meanLuma: number;
	};
}

/**
 * Foreground-aware auto-levels + white-patch white balance in one pass:
 *  - white balance anchors on the near-white highlights (the {@link WB_WHITE_PCT}
 *    percentile of each channel) rather than the frame average: each channel is
 *    scaled so that reference lines up with the brightest channel's, neutralising
 *    the ambient cast on whites *without* desaturating strongly-coloured content.
 *    (Grey-world — scaling every channel toward the overall mean — wrecks a
 *    dominantly-coloured sleeve: a navy cover would be pushed grey, i.e. yellow.)
 *    Damped by `wbStrength` and clamped so it never swings wildly.
 *  - levels stretch a *single* luma [lowPct, highPct] range to [0,255], applied
 *    identically to every channel, so contrast opens up without shifting hue
 *    (an independent per-channel stretch skews the colour of a saturated cover);
 *  - one global gamma nudges the mean luma toward `targetMid` for consistent
 *    exposure across shots.
 * Only opaque pixels feed the statistics, so the transparent margin never skews
 * them; alpha is passed through untouched.
 */
export function autoTone(
	img: RgbaImage,
	opts: AutoToneOptions = {},
): AutoToneResult {
	const {
		alphaMin = 16,
		lowPct = 0.005,
		highPct = 0.995,
		wbStrength = 1.0,
		targetMid = 0.5,
	} = opts;

	const { hist, lumaHist, mean, n } = foregroundStats(img, alphaMin);

	// White-patch balance: line each channel's near-white reference up with the
	// brightest channel's, so whites go neutral while saturated midtones keep their hue.
	const whiteRef = [0, 1, 2].map((c) =>
		Math.max(percentile(hist[c], n, WB_WHITE_PCT), 1),
	);
	const refWhite = Math.max(...whiteRef);
	// No plausible white point on a dark/low-key cover: don't invent a cast to correct.
	// Damp continuously (not a hard cutoff) so covers near the floor don't jump abruptly.
	const preMeanLuma = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
	const refTrust = Math.min(1, Math.max(0, refWhite / WB_MIN_REF_BRIGHTNESS));
	const lumaTrust = Math.min(1, Math.max(0, preMeanLuma / WB_MIN_MEAN_LUMA));
	const spreadFrac = (refWhite - Math.min(...whiteRef)) / refWhite;
	const neutralTrust = Math.min(
		1,
		Math.max(0, 1 - spreadFrac / (2 * WB_MAX_NEUTRAL_SPREAD)),
	);
	const effectiveWbStrength = wbStrength * refTrust * lumaTrust * neutralTrust;
	const wbGain: [number, number, number] = [1, 1, 1];
	for (let c = 0; c < 3; c++) {
		const g = refWhite / whiteRef[c];
		const damped = 1 + (g - 1) * effectiveWbStrength;
		// Clamp the per-channel gain to ±30%. A strongly-coloured cover drives one
		// channel's near-white reference far above the others; a looser clamp (this was
		// ±60%) let that swing green/cyan the whole midtone range. ±30% still neutralises
		// a real ambient cast without letting a saturated sleeve wreck the grade.
		wbGain[c] = Math.min(1.3, Math.max(1 / 1.3, damped));
	}

	// A single luma-domain levels window, applied to every channel alike (hue-preserving).
	const loL = percentile(lumaHist, n, lowPct);
	const hiL = percentile(lumaHist, n, highPct);
	const span = hiL - loL;
	const lo = [loL, loL, loL];
	const hi = [hiL, hiL, hiL];

	// LUT per channel: white-balance gain, then the shared luma levels stretch. A
	// near-uniform frame with no usable spread would otherwise collapse to black, so
	// we skip the stretch there and just apply the balance gain.
	const lut = [0, 1, 2].map((c) => {
		const table = new Uint8ClampedArray(256);
		for (let v = 0; v < 256; v++) {
			const balanced = v * wbGain[c];
			table[v] = span < 1 ? balanced : ((balanced - loL) / span) * 255;
		}
		return table;
	});

	const { data, width, height } = img;
	// Mean luma after the LUT, to pick one gamma toward targetMid.
	let lumaSum = 0;
	let lumaN = 0;
	for (let p = 0; p < width * height; p++) {
		if (data[p * 4 + 3] < alphaMin) continue;
		const r = lut[0][data[p * 4]];
		const g = lut[1][data[p * 4 + 1]];
		const b = lut[2][data[p * 4 + 2]];
		lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
		lumaN++;
	}
	const meanLuma = lumaSum / Math.max(lumaN, 1) / 255;
	const gamma =
		meanLuma > 0.01 && meanLuma < 0.99
			? Math.log(meanLuma) / Math.log(targetMid)
			: 1;
	const gammaLut = new Uint8ClampedArray(256);
	for (let v = 0; v < 256; v++) gammaLut[v] = (v / 255) ** (1 / gamma) * 255;

	const out = new Uint8ClampedArray(data.length);
	for (let p = 0; p < width * height; p++) {
		out[p * 4] = gammaLut[lut[0][data[p * 4]]];
		out[p * 4 + 1] = gammaLut[lut[1][data[p * 4 + 1]]];
		out[p * 4 + 2] = gammaLut[lut[2][data[p * 4 + 2]]];
		out[p * 4 + 3] = data[p * 4 + 3];
	}
	return {
		data: out,
		width,
		height,
		debug: { wbGain, lo, hi, gamma, meanLuma },
	};
}

/**
 * The full deterministic reframe: given the raw capture and the sleeve's four
 * `corners` (TL,TR,BR,BL, in the capture's pixel coordinates — as picked in the admin
 * editor), perspective-warp the sleeve onto a `contentSize` square, pad it out to a
 * `canvasSize` square (the even gap is the transparent margin), and auto-tone. The
 * capture is fully opaque, so the warped content square is opaque and the padded
 * margin is transparent — which is exactly what {@link autoTone}'s foreground-only
 * statistics expect. Pass `tone: false` to skip the tone stage entirely and keep the
 * warped capture's original exposure/colour (the white-balance/levels/gamma stretch
 * can amplify real surface sheen into a hard highlight, so an untoned compare is
 * useful). Returns the final RGBA square.
 */
export function reframeFromCorners(
	capture: RgbaImage,
	corners: Corners,
	opts: {
		canvasSize: number;
		contentSize: number;
		tone?: AutoToneOptions | false;
	},
): { image: RgbaImage } {
	const content = warpToSquare(capture, corners, opts.contentSize);
	const padded = padToCanvas(content, opts.canvasSize);
	const framed = opts.tone === false ? padded : autoTone(padded, opts.tone);
	return {
		image: { data: framed.data, width: framed.width, height: framed.height },
	};
}

/**
 * Apply the "polish" factors to `img` **in place**: saturation around per-pixel luma,
 * then contrast around mid-grey, then gamma. `1.0` = no change for each, so untouched
 * knobs are a fast no-op. `data` is a Uint8ClampedArray, so writes clamp to [0,255].
 *
 * Deliberately done in pixels (not via the Cloudflare Images `.transform()` colour
 * pass) so the stored image matches the client preview exactly, and so it works the
 * same in local dev — where the Images binding resizes/sharpens but does *not* apply
 * colour transforms — as it does in production.
 */
export function applyPolish(
	img: RgbaImage,
	sat: number,
	contrast: number,
	gamma: number,
): void {
	if (sat === 1 && contrast === 1 && gamma === 1) return;
	const d = img.data;
	const gInv = 1 / gamma;
	for (let i = 0; i < d.length; i += 4) {
		let r = d[i];
		let g = d[i + 1];
		let b = d[i + 2];
		if (sat !== 1) {
			const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			r = l + (r - l) * sat;
			g = l + (g - l) * sat;
			b = l + (b - l) * sat;
		}
		if (contrast !== 1) {
			r = (r - 128) * contrast + 128;
			g = (g - 128) * contrast + 128;
			b = (b - 128) * contrast + 128;
		}
		if (gamma !== 1) {
			r = 255 * (Math.max(0, r) / 255) ** gInv;
			g = 255 * (Math.max(0, g) / 255) ** gInv;
			b = 255 * (Math.max(0, b) / 255) ** gInv;
		}
		d[i] = r;
		d[i + 1] = g;
		d[i + 2] = b;
	}
}

// ---------- edge refinement (the corner editor's Snap, and the detector's refine pass) ----------

/** A pixel-space corner band: `outer` wholly on background, `inner` wholly on sleeve. */
export interface PixelBand {
	inner: Corners;
	outer: Corners;
}

/** The corner-wise midpoint quad of a band — the best single-line guess at the edge. */
export function midQuad(inner: Corners, outer: Corners): Corners {
	return inner.map(([x, y], i) => [
		(x + outer[i][0]) / 2,
		(y + outer[i][1]) / 2,
	]) as Corners;
}

/**
 * Per-edge distance from each of `from`'s edges to the corresponding edge of `to`
 * (edge midpoint to the other quad's edge line) — how much room the band gives on
 * each side of a quad, in px. Edge order matches everywhere else (top, right,
 * bottom, left as TL→TR, TR→BR, BR→BL, BL→TL).
 */
export function edgeDistances(
	from: Corners,
	to: Corners,
): [number, number, number, number] {
	const out: number[] = [];
	for (let e = 0; e < 4; e++) {
		const [ax, ay] = from[e];
		const [bx, by] = from[(e + 1) % 4];
		const mx = (ax + bx) / 2;
		const my = (ay + by) / 2;
		const [cx1, cy1] = to[e];
		const [cx2, cy2] = to[(e + 1) % 4];
		const ex = cx2 - cx1;
		const ey = cy2 - cy1;
		const len = Math.hypot(ex, ey) || 1;
		out.push(Math.abs(ex * (my - cy1) - ey * (mx - cx1)) / len);
	}
	return out as [number, number, number, number];
}

/** Intersection point of two infinite lines, each given by two points on it. */
function lineIntersect(a1: Corner, a2: Corner, b1: Corner, b2: Corner): Corner {
	const d =
		(a1[0] - a2[0]) * (b1[1] - b2[1]) - (a1[1] - a2[1]) * (b1[0] - b2[0]);
	if (Math.abs(d) < 1e-9) return a2; // near-parallel — fall back to an endpoint
	const pa = a1[0] * a2[1] - a1[1] * a2[0];
	const pb = b1[0] * b2[1] - b1[1] * b2[0];
	return [
		(pa * (b1[0] - b2[0]) - (a1[0] - a2[0]) * pb) / d,
		(pa * (b1[1] - b2[1]) - (a1[1] - a2[1]) * pb) / d,
	];
}

/**
 * How hard {@link refineQuadEdges} biases toward the picked edge over a distant one:
 * the gradient score is scaled by `1 - FALLOFF * (distance / search)`, so at the far
 * reach of the search a competing edge keeps only `1 - FALLOFF` of its strength. Tuned
 * so the true sleeve edge (near the pick) wins over a stronger wood-plank seam metres of
 * pixels away, without being so aggressive it can't reach a genuinely-offset edge.
 */
const EDGE_PROXIMITY_FALLOFF = 0.7;

/**
 * Below this per-edge confidence (see {@link refineQuadEdgesDetailed}), an edge's
 * gradient search found no clear boundary — the score band is essentially flat noise —
 * so the refinement reverts that edge to the admin's picked line rather than trusting a
 * noise peak. Confidence is the peak-to-median ratio of the raw (unweighted) scores
 * across the search band: a real edge is a sharp spike over a flat floor (ratio ≫ 3);
 * dark-mat-on-dark-wood ambiguity, or a soft-focus/noisy source photo where the
 * sleeve/background transition itself spans several pixels, reads as a lumpy plateau
 * (ratio → 1–2). Set a notch above that floor rather than right at it, so a genuinely
 * blurred edge falls back to the admin's picked line — which the admin drew looking at
 * the same soft photo — instead of the gradient search locking onto whichever noisy
 * pixel happened to spike highest.
 */
export const EDGE_CONFIDENCE_MIN = 4;

/** Per-edge confidences in edge order (TL→TR, TR→BR, BR→BL, BL→TL). */
export type EdgeConfidence = [number, number, number, number];

export interface RefinedQuad {
	corners: Corners;
	/** Peak-to-median gradient ratio per edge; higher = clearer boundary. */
	confidence: EdgeConfidence;
}

/**
 * Refine a starting `quad` (the admin's picked corners, mapped into `img`) to the
 * sleeve's true edges: slide each of the four edges along its outward normal to the
 * offset with the strongest *summed* colour gradient — the full-length sleeve/background
 * transition — weighted toward the picked position (see {@link EDGE_PROXIMITY_FALLOFF}).
 * Because the score sums the whole edge, a local bump (a neighbouring record poking in)
 * or per-pixel noise can't pull it; the result is four clean, straight lines whose
 * intersections are the refined corners. This is why the picked points matter: they say
 * where each edge roughly is, so we only search a band around it.
 *
 * The gradient is per-channel colour difference, not luminance: a dark charcoal mat on
 * dark shadowed wood is a near-zero *luma* step but a strong *chroma* step (neutral grey
 * vs warm brown), and that is exactly where the corners of a matte fail. Any colour or
 * brightness difference scores, so this is backdrop-agnostic (wood, white or grey paper).
 *
 * Also reports a per-edge confidence, and — when `minConfidence` is set — reverts any
 * edge whose search found no real boundary back to the picked line, so an ambiguous
 * edge degrades to "cut where the admin drew" instead of a noise-driven guess.
 */
export function refineQuadEdgesDetailed(
	img: RgbaImage,
	quad: Corners,
	opts: {
		search?: number;
		samples?: number;
		minConfidence?: number;
		/**
		 * Explicit per-edge search bounds (px along the outward normal), overriding the
		 * `search`-derived defaults. Used with a corner band: `quad` is the band midline
		 * and these are the per-edge distances to the outer/inner quads, so the search
		 * can't leave the certified-unknown band.
		 */
		outward?: EdgeDeltas;
		inward?: EdgeDeltas;
	} = {},
): RefinedQuad {
	const { width, height, data } = img;
	const samples = opts.samples ?? 64;
	const search = opts.search ?? Math.round(Math.min(width, height) * 0.12);
	const idx = (x: number, y: number): number => {
		const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
		const yi = Math.min(height - 1, Math.max(0, Math.round(y)));
		return (yi * width + xi) * 4;
	};
	// Summed |ΔR|+|ΔG|+|ΔB| across the edge normal — catches chroma-only boundaries
	// that a luminance gradient misses entirely.
	const colorDiff = (
		ax: number,
		ay: number,
		bx: number,
		by: number,
	): number => {
		const i = idx(ax, ay);
		const j = idx(bx, by);
		return (
			Math.abs(data[i] - data[j]) +
			Math.abs(data[i + 1] - data[j + 1]) +
			Math.abs(data[i + 2] - data[j + 2])
		);
	};
	const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
	const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
	// The four (shifted) edge lines, each as two points.
	const lines: Array<[Corner, Corner]> = [];
	const confidence: number[] = [];
	for (let e = 0; e < 4; e++) {
		const [ax, ay] = quad[e];
		const [bx, by] = quad[(e + 1) % 4];
		const ex = bx - ax;
		const ey = by - ay;
		const el = Math.hypot(ex, ey) || 1;
		let nx = -ey / el;
		let ny = ex / el;
		const mx = ax + ex * 0.5;
		const my = ay + ey * 0.5;
		if ((mx - cx) * nx + (my - cy) * ny < 0) {
			nx = -nx;
			ny = -ny;
		}
		let bestDelta = 0;
		let bestScore = -1;
		// Default: mostly outward (a single pick sits inside the cover), a little inward.
		// A band caller passes explicit per-edge bounds instead (midline → outer/inner).
		const perEdge = (d: EdgeDeltas | undefined, fallback: number): number => {
			if (d == null) return fallback;
			return Math.max(1, Math.round(typeof d === "number" ? d : d[e]));
		};
		const outward = perEdge(opts.outward, Math.max(1, search));
		const inward = perEdge(opts.inward, Math.max(1, Math.round(search * 0.5)));
		const rawScores: number[] = [];
		for (let d = -inward; d <= outward; d++) {
			let score = 0;
			for (let s = 0; s < samples; s++) {
				const t = (s + 0.5) / samples;
				const px = ax + ex * t + nx * d;
				const py = ay + ey * t + ny * d;
				score += colorDiff(px + nx, py + ny, px - nx, py - ny);
			}
			rawScores.push(score);
			// Prefer the edge nearest the picked line. Without this, a stronger gradient
			// far outside the sleeve — a wood-plank seam in the floor beyond the cover, say —
			// out-scores the true edge and drags the quad out into the background, which the
			// trimap then locks as foreground (the big wood chunk in the matte). Falloff is
			// normalised per side, so the true edge close to the pick wins unless a distant
			// one is dramatically stronger.
			const norm = d >= 0 ? d / outward : -d / inward;
			score *= 1 - EDGE_PROXIMITY_FALLOFF * norm;
			if (score > bestScore) {
				bestScore = score;
				bestDelta = d;
			}
		}
		// Confidence from the *raw* scores (the falloff would fake a peak at d=0 on a
		// flat field). Median as the floor: robust to a second edge in the band.
		const peak = Math.max(...rawScores);
		const median = rawScores.slice().sort((a, b) => a - b)[
			Math.floor(rawScores.length / 2)
		];
		const conf = peak <= 1e-3 ? 0 : peak / Math.max(median, peak * 0.01, 1e-3);
		confidence.push(conf);
		if (opts.minConfidence != null && conf < opts.minConfidence) bestDelta = 0;
		lines.push([
			[ax + nx * bestDelta, ay + ny * bestDelta],
			[bx + nx * bestDelta, by + ny * bestDelta],
		]);
	}
	// Corner i is where edge (i-1) meets edge i.
	const corners = [0, 1, 2, 3].map((i) => {
		const prev = lines[(i + 3) % 4];
		const cur = lines[i];
		return lineIntersect(prev[0], prev[1], cur[0], cur[1]);
	}) as Corners;
	return { corners, confidence: confidence as EdgeConfidence };
}

/** {@link refineQuadEdgesDetailed}, corners only — for callers that don't need confidence. */
export function refineQuadEdges(
	img: RgbaImage,
	quad: Corners,
	opts: { search?: number; samples?: number; minConfidence?: number } = {},
): Corners {
	return refineQuadEdgesDetailed(img, quad, opts).corners;
}

/** A uniform edge offset, or one per edge (TL→TR, TR→BR, BR→BL, BL→TL). */
export type EdgeDeltas = number | readonly [number, number, number, number];

/**
 * Shift each of the quad's four edges by `delta` px along its outward normal (positive
 * `delta` = dilate outward, negative = erode inward), then intersect adjacent shifted
 * lines for the new corners — a clean geometric grow/shrink that keeps the rectangle a
 * rectangle. Used to bracket the true sleeve edge when building a trimap from the picked
 * corners. `delta` may be per-edge, so a single ambiguous edge can be treated more
 * conservatively than its confident neighbours.
 */
export function offsetQuad(quad: Corners, delta: EdgeDeltas): Corners {
	const deltas =
		typeof delta === "number" ? [delta, delta, delta, delta] : delta;
	const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
	const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
	const lines: Array<[Corner, Corner]> = [];
	for (let e = 0; e < 4; e++) {
		const [ax, ay] = quad[e];
		const [bx, by] = quad[(e + 1) % 4];
		const ex = bx - ax;
		const ey = by - ay;
		const el = Math.hypot(ex, ey) || 1;
		let nx = -ey / el;
		let ny = ex / el;
		// Orient the normal outward once, via the edge midpoint relative to the centroid.
		if ((ax + ex * 0.5 - cx) * nx + (ay + ey * 0.5 - cy) * ny < 0) {
			nx = -nx;
			ny = -ny;
		}
		const d = deltas[e];
		lines.push([
			[ax + nx * d, ay + ny * d],
			[bx + nx * d, by + ny * d],
		]);
	}
	return [0, 1, 2, 3].map((i) => {
		const prev = lines[(i + 3) % 4];
		const cur = lines[i];
		return lineIntersect(prev[0], prev[1], cur[0], cur[1]);
	}) as Corners;
}
