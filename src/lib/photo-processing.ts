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
 * Works off EDGES, not colour: the sleeve sits on wood and nearly fills the frame, so its
 * four straight borders are the strongest luminance transitions near the frame. For each
 * side we scan inward from the frame within an outer band and, on every scanline, take the
 * position of the strongest gradient — one candidate edge point per scanline. A robust
 * Theil–Sen line fit through those points gives that side's line; because each side is
 * fitted independently the result can tilt and keystone. The robust fit and a per-side
 * gradient threshold reject scanlines where the border is worn/occluded or an internal
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
		const raw: Array<[number, number, number]> = []; // [u, v, gradient]
		let maxGrad = 0;
		// Snap the scan start onto the stride grid so `v` stays an integer. The right/bottom
		// sides pass `lo = size * (1 - BAND)`, rarely a whole number; adding the integer
		// `stride` never clears the fraction, and a fractional index into the RGBA buffer
		// reads back as `undefined` → NaN — which silently zeroes the gradient search for
		// those sides and bails the whole detector to null on any capture whose size doesn't
		// happen to make that boundary land on a whole pixel.
		const vStart = Math.max(stride, Math.ceil(lo / stride) * stride);
		for (let u = 0; u < along; u += stride) {
			let bestV = -1;
			let bestG = -1;
			for (let v = vStart; v < hi; v += stride) {
				const g = vertical
					? Math.abs(lum(v, u) - lum(v - stride, u))
					: Math.abs(lum(u, v) - lum(u, v - stride));
				if (g > bestG) {
					bestG = g;
					bestV = v;
				}
			}
			if (bestV >= 0) {
				raw.push([u, bestV, bestG]);
				if (bestG > maxGrad) maxGrad = bestG;
			}
		}
		const cutoff = maxGrad * KEEP_FRAC;
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

// ---------- alpha matte: a transparent, true-edged sleeve floating in space ----------
//
// The square reframe above forces the four corners onto a perfect rectangle, which
// straightens the sleeve's real, slightly-off-square outline by construction. The
// matte wants the opposite: keep the honest edge and float the object on a
// transparent margin. So instead of squaring, we *mildly deskew* (rotate the sleeve
// upright without squaring), cut it out with an alpha mask (a deterministic edge-snap
// silhouette here, or a matting model's alpha in the server path), pad it out to a
// transparent canvas, tone it, and lay a synthesised contact shadow underneath.
// Everything here is pure — the same math runs client-side in the editor preview.

/**
 * A destination quad that rotates `corners` (pixel-space TL,TR,BR,BL) upright —
 * removing the capture's tilt from the average of the two horizontal edges —
 * *without* squaring them, so the sleeve keeps its real aspect and slight keystone.
 * The quad is translated to the origin; `width`/`height` are its bounding box.
 */
export function deskewToLevel(corners: Corners): {
	dst: Corners;
	width: number;
	height: number;
} {
	const [tl, tr, br, bl] = corners;
	// Tilt = the mean angle of the top (TL→TR) and bottom (BL→BR) edges off horizontal.
	const aTop = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
	const aBot = Math.atan2(br[1] - bl[1], br[0] - bl[0]);
	const angle = (aTop + aBot) / 2;
	const cos = Math.cos(-angle);
	const sin = Math.sin(-angle);
	const rot = corners.map(
		([x, y]) => [x * cos - y * sin, x * sin + y * cos] as Corner,
	) as Corners;
	const xs = rot.map((p) => p[0]);
	const ys = rot.map((p) => p[1]);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	const maxX = Math.max(...xs);
	const maxY = Math.max(...ys);
	const dst = rot.map(([x, y]) => [x - minX, y - minY] as Corner) as Corners;
	return {
		dst,
		width: Math.max(1, Math.ceil(maxX - minX)),
		height: Math.max(1, Math.ceil(maxY - minY)),
	};
}

/**
 * Deskew `capture` upright (via {@link deskewToLevel}) and scale it so the sleeve's
 * longer side is `contentSize` px, warping the real capture pixels onto that quad.
 * Returns the deskewed content (opaque, with triangular background wedges the mask
 * will cut away) plus the destination `corners` in the content's own pixel space —
 * the near-border quad the silhouette/mask is built against.
 */
export function deskewContent(
	capture: RgbaImage,
	corners: Corners,
	contentSize: number,
): { content: RgbaImage; corners: Corners } {
	const { dst, width, height } = deskewToLevel(corners);
	const scale = contentSize / Math.max(width, height);
	const sdst = dst.map(([x, y]) => [x * scale, y * scale] as Corner) as Corners;
	const cw = Math.max(1, Math.round(width * scale));
	const ch = Math.max(1, Math.round(height * scale));
	return {
		content: warpToQuad(capture, corners, sdst, cw, ch),
		corners: sdst,
	};
}

/**
 * A separable box blur over a single-channel (`width`×`height`) buffer, repeated
 * `passes` times to approach a Gaussian. Returns a fresh buffer; used both to feather
 * a hard mask edge and to soften a shadow. O(n) per pass via a running window sum.
 */
export function boxBlur1(
	src: Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
	passes = 1,
): Uint8ClampedArray {
	if (radius < 1) return src.slice();
	const win = radius * 2 + 1;
	let buf = src;
	for (let p = 0; p < passes; p++) {
		// Horizontal pass.
		const h = new Uint8ClampedArray(width * height);
		for (let y = 0; y < height; y++) {
			const row = y * width;
			let sum = 0;
			for (let x = -radius; x <= radius; x++)
				sum += buf[row + Math.min(width - 1, Math.max(0, x))];
			for (let x = 0; x < width; x++) {
				h[row + x] = sum / win;
				const add = Math.min(width - 1, x + radius + 1);
				const sub = Math.max(0, x - radius);
				sum += buf[row + add] - buf[row + sub];
			}
		}
		// Vertical pass.
		const v = new Uint8ClampedArray(width * height);
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let y = -radius; y <= radius; y++)
				sum += h[Math.min(height - 1, Math.max(0, y)) * width + x];
			for (let y = 0; y < height; y++) {
				v[y * width + x] = sum / win;
				const add = Math.min(height - 1, y + radius + 1);
				const sub = Math.max(0, y - radius);
				sum += h[add * width + x] - h[sub * width + x];
			}
		}
		buf = v;
	}
	return buf;
}

/**
 * Scan-line fill a closed polygon (`points` in pixel coords) into a single-channel
 * `width`×`height` mask: 255 inside, 0 outside, using the even-odd rule at each
 * pixel-row centre. Feather afterwards for a soft edge.
 */
export function rasterizePolygon(
	points: Array<[number, number]>,
	width: number,
	height: number,
): Uint8ClampedArray {
	const mask = new Uint8ClampedArray(width * height);
	const n = points.length;
	for (let y = 0; y < height; y++) {
		const yc = y + 0.5;
		const xs: number[] = [];
		for (let i = 0; i < n; i++) {
			const [x1, y1] = points[i];
			const [x2, y2] = points[(i + 1) % n];
			if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
				xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
			}
		}
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
			const xb = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
			for (let x = xa; x <= xb; x++) mask[y * width + x] = 255;
		}
	}
	return mask;
}

/**
 * Keep only the largest connected blob of a mask (4-connectivity, pixels ≥ `threshold`),
 * zeroing everything else. A matting model often keeps stray bits — a sliver of a
 * neighbouring record, a shadow speck — disconnected from the sleeve; those would
 * enlarge the alpha bounding box and throw off the crop, so we drop them here.
 */
export function keepLargestComponent(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	threshold = 128,
): Uint8ClampedArray {
	const n = width * height;
	const label = new Int32Array(n).fill(-1);
	const stack: number[] = [];
	let bestLabel = -1;
	let bestSize = 0;
	let cur = 0;
	for (let i = 0; i < n; i++) {
		if (mask[i] < threshold || label[i] !== -1) continue;
		let size = 0;
		label[i] = cur;
		stack.push(i);
		while (stack.length) {
			const p = stack.pop() as number;
			size++;
			const x = p % width;
			const y = (p / width) | 0;
			if (x > 0 && mask[p - 1] >= threshold && label[p - 1] === -1) {
				label[p - 1] = cur;
				stack.push(p - 1);
			}
			if (x < width - 1 && mask[p + 1] >= threshold && label[p + 1] === -1) {
				label[p + 1] = cur;
				stack.push(p + 1);
			}
			if (y > 0 && mask[p - width] >= threshold && label[p - width] === -1) {
				label[p - width] = cur;
				stack.push(p - width);
			}
			if (
				y < height - 1 &&
				mask[p + width] >= threshold &&
				label[p + width] === -1
			) {
				label[p + width] = cur;
				stack.push(p + width);
			}
		}
		if (size > bestSize) {
			bestSize = size;
			bestLabel = cur;
		}
		cur++;
	}
	const out = new Uint8ClampedArray(n);
	if (bestLabel < 0) return out;
	for (let i = 0; i < n; i++) out[i] = label[i] === bestLabel ? mask[i] : 0;
	return out;
}

/** Feather a hard mask edge with a couple of box-blur passes (soft alpha falloff). */
export function featherMask(
	mask: Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
): Uint8ClampedArray {
	return boxBlur1(mask, width, height, radius, 2);
}

/** Multiply `img`'s alpha by `mask` (0..255) in place — cut the sleeve out to the mask. */
export function applyMask(img: RgbaImage, mask: Uint8ClampedArray): void {
	const d = img.data;
	for (let p = 0; p < img.width * img.height; p++) {
		d[p * 4 + 3] = (d[p * 4 + 3] * mask[p]) / 255;
	}
}

/**
 * Extend the opaque region's colour outward into the transparent margin by `radius` px
 * (RGB only — alpha untouched), flood-filling each transparent pixel from its nearest
 * solid neighbour. Run this on a cut-out *before* a bilinear warp/downscale: the soft
 * edge then blends the sleeve's own colour instead of whatever sat just outside it (the
 * tan wood fringe), so the real, ragged alpha edge survives clean — no need to choke it
 * inward. In place.
 */
export function bleedEdgeColor(img: RgbaImage, radius: number): void {
	const { data, width, height } = img;
	const solid = new Uint8Array(width * height);
	for (let p = 0; p < width * height; p++)
		solid[p] = data[p * 4 + 3] >= 8 ? 1 : 0;
	for (let pass = 0; pass < radius; pass++) {
		const added: number[] = [];
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const p = y * width + x;
				if (solid[p]) continue;
				let q = -1;
				if (x > 0 && solid[p - 1]) q = p - 1;
				else if (x < width - 1 && solid[p + 1]) q = p + 1;
				else if (y > 0 && solid[p - width]) q = p - width;
				else if (y < height - 1 && solid[p + width]) q = p + width;
				if (q >= 0) {
					data[p * 4] = data[q * 4];
					data[p * 4 + 1] = data[q * 4 + 1];
					data[p * 4 + 2] = data[q * 4 + 2];
					added.push(p);
				}
			}
		}
		for (const p of added) solid[p] = 1;
	}
}

export interface ShadowOptions {
	/** Blur radius of the shadow, px. */
	blur: number;
	/** Offset from the sleeve, px (a small down/right cast reads as a contact shadow). */
	offsetX: number;
	offsetY: number;
	/** Shadow colour (default near-black) and peak opacity (0..1). */
	tint?: [number, number, number];
	opacity?: number;
}

/**
 * Synthesise a soft contact shadow from an image's own alpha: blur the silhouette,
 * offset it, tint it, and scale by `opacity`. Returns a same-size RGBA layer meant to
 * sit *under* the sleeve (see {@link compositeUnder}) — deterministic and consistent
 * across the whole collection, unlike trying to recover the real cast shadow.
 */
export function shadowFromAlpha(
	img: RgbaImage,
	{ blur, offsetX, offsetY, tint = [0, 0, 0], opacity = 0.35 }: ShadowOptions,
): RgbaImage {
	const { width, height } = img;
	const alpha = new Uint8ClampedArray(width * height);
	for (let p = 0; p < width * height; p++) alpha[p] = img.data[p * 4 + 3];
	const blurred = boxBlur1(alpha, width, height, Math.max(1, blur), 3);
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sx = x - offsetX;
			const sy = y - offsetY;
			if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
			const d = (y * width + x) * 4;
			data[d] = tint[0];
			data[d + 1] = tint[1];
			data[d + 2] = tint[2];
			data[d + 3] = blurred[sy * width + sx] * opacity;
		}
	}
	return { data, width, height };
}

/** Composite `base` over `under` (straight alpha) — returns a fresh RGBA image. */
export function compositeUnder(base: RgbaImage, under: RgbaImage): RgbaImage {
	const { width, height } = base;
	const out = new Uint8ClampedArray(width * height * 4);
	const b = base.data;
	const u = under.data;
	for (let p = 0; p < width * height; p++) {
		const ba = b[p * 4 + 3] / 255;
		const ua = u[p * 4 + 3] / 255;
		const oa = ba + ua * (1 - ba);
		for (let c = 0; c < 3; c++) {
			out[p * 4 + c] =
				oa > 0 ? (b[p * 4 + c] * ba + u[p * 4 + c] * ua * (1 - ba)) / oa : 0;
		}
		out[p * 4 + 3] = oa * 255;
	}
	return { data: out, width, height };
}

/**
 * Walk points along each of the four `corners`-edges of `img` and snap each to the
 * strongest local luminance gradient within ±`band` px along the edge's outward
 * normal — turning the nominal straight edges into an organic polyline that bows with
 * the real sleeve outline. Reuses the same Rec.709-luma gradient signal as {@link
 * detectSleeveCorners}. Where the gradient is flat (sleeve and background share a
 * tone) it keeps the nominal point, degrading safely to the straight corner edge.
 */
export function edgeSnapSilhouette(
	img: RgbaImage,
	corners: Corners,
	opts: {
		samples?: number;
		band?: number;
		gradMin?: number;
		smooth?: number;
	} = {},
): Array<[number, number]> {
	const { width, height, data } = img;
	const samples = opts.samples ?? 32;
	const band =
		opts.band ?? Math.max(4, Math.round(Math.min(width, height) * 0.03));
	const gradMin = opts.gradMin ?? 12;
	// Moving-average radius over each edge's snapped offsets — turns a jittery,
	// noise-chasing outline into a clean bow. 0 disables smoothing.
	const smooth = opts.smooth ?? 2;
	const lum = (x: number, y: number): number => {
		const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
		const yi = Math.min(height - 1, Math.max(0, Math.round(y)));
		const i = (yi * width + xi) * 4;
		return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
	};
	const cx =
		(corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
	const cy =
		(corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
	const pts: Array<[number, number]> = [];
	for (let e = 0; e < 4; e++) {
		const [ax, ay] = corners[e];
		const [bx, by] = corners[(e + 1) % 4];
		const ex = bx - ax;
		const ey = by - ay;
		const el = Math.hypot(ex, ey) || 1;
		// Outward normal (perpendicular to the edge). Orient it ONCE per edge, off the
		// edge midpoint, so it points away from the centroid — flipping it per-sample
		// (as an earlier version did) let it oscillate and threw the outline around.
		let nx = -ey / el;
		let ny = ex / el;
		const mx = ax + ex * 0.5;
		const my = ay + ey * 0.5;
		if ((mx - cx) * nx + (my - cy) * ny < 0) {
			nx = -nx;
			ny = -ny;
		}
		// 1) Raw snapped offset per sample — the strongest luminance gradient within
		//    ±band along the normal (or 0, i.e. the nominal edge, where it's flat).
		//    Sample [0,1) so the shared corner isn't emitted twice by adjacent edges.
		const off = new Array<number>(samples);
		for (let s = 0; s < samples; s++) {
			const t = s / samples;
			const px = ax + ex * t;
			const py = ay + ey * t;
			let best = 0;
			let bestK = 0;
			for (let k = -band; k <= band; k++) {
				const g = Math.abs(
					lum(px + nx * (k + 1), py + ny * (k + 1)) -
						lum(px + nx * (k - 1), py + ny * (k - 1)),
				);
				if (g > best) {
					best = g;
					bestK = k;
				}
			}
			off[s] = best >= gradMin ? bestK : 0;
		}
		// 2) Smooth the offsets, then emit the points along the (smoothed) normal.
		for (let s = 0; s < samples; s++) {
			let sum = 0;
			let n = 0;
			for (let d = -smooth; d <= smooth; d++) {
				const j = s + d;
				if (j >= 0 && j < samples) {
					sum += off[j];
					n++;
				}
			}
			const k = sum / n;
			const t = s / samples;
			pts.push([ax + ex * t + nx * k, ay + ey * t + ny * k]);
		}
	}
	return pts;
}

/** Crop a `w`×`h` window from `img` at (`x`,`y`); out-of-bounds reads transparent. */
export function cropImage(
	img: RgbaImage,
	x: number,
	y: number,
	w: number,
	h: number,
): RgbaImage {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let ry = 0; ry < h; ry++) {
		for (let rx = 0; rx < w; rx++) {
			const sx = x + rx;
			const sy = y + ry;
			if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
			const s = (sy * img.width + sx) * 4;
			const d = (ry * w + rx) * 4;
			data[d] = img.data[s];
			data[d + 1] = img.data[s + 1];
			data[d + 2] = img.data[s + 2];
			data[d + 3] = img.data[s + 3];
		}
	}
	return { data, width: w, height: h };
}

/** Bilinearly resample `img` to `tw`×`th` (a plain resize via the quad warp). */
export function resizeImage(img: RgbaImage, tw: number, th: number): RgbaImage {
	return warpToQuad(
		img,
		[
			[0, 0],
			[img.width - 1, 0],
			[img.width - 1, img.height - 1],
			[0, img.height - 1],
		],
		[
			[0, 0],
			[tw - 1, 0],
			[tw - 1, th - 1],
			[0, th - 1],
		],
		tw,
		th,
	);
}

/** The bounding box of `img`'s opaque (alpha ≥ `alphaMin`) pixels, or null if none. */
export function alphaBounds(
	img: RgbaImage,
	alphaMin = 16,
): { x: number; y: number; w: number; h: number } | null {
	let minX = img.width;
	let minY = img.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			if (img.data[(y * img.width + x) * 4 + 3] >= alphaMin) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return null;
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Like {@link deskewContent}, but the sleeve is centred at `1 - 2·pad` of a square
 * `outSize` output, so a margin of the *surrounding* capture (the wood the sleeve sits
 * on) frames it. That context is what lets a matting model read the sleeve as a
 * rectangular object on a surface and cut the wood away — where a tight crop of just
 * the cover reads as a scene, and the model segments the *depicted* subject instead.
 */
export function deskewContentPadded(
	capture: RgbaImage,
	corners: Corners,
	outSize: number,
	pad: number,
): { content: RgbaImage; corners: Corners } {
	const { dst, width, height } = deskewToLevel(corners);
	const inner = outSize * (1 - 2 * pad);
	const scale = inner / Math.max(width, height);
	const sw = width * scale;
	const sh = height * scale;
	const offX = (outSize - sw) / 2;
	const offY = (outSize - sh) / 2;
	const sdst = dst.map(
		([x, y]) => [x * scale + offX, y * scale + offY] as Corner,
	) as Corners;
	return {
		content: warpToQuad(capture, corners, sdst, outSize, outSize),
		corners: sdst,
	};
}

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

/**
 * Like {@link deskewContentPadded}, but for a corner band: deskew + scale by the
 * `outer` quad (it bounds the whole sleeve, so the entire unknown band lands inside
 * the frame with `pad` of surrounding capture around it) and map the `inner` quad
 * through the same transform. Both returned quads are in the content's pixel space.
 */
export function deskewBandPadded(
	capture: RgbaImage,
	band: PixelBand,
	outSize: number,
	pad: number,
): { content: RgbaImage; inner: Corners; outer: Corners } {
	const { content, corners: outer } = deskewContentPadded(
		capture,
		band.outer,
		outSize,
		pad,
	);
	// Forward capture→content mapping (the deskew warp's inverse direction):
	// homography(A, B) maps A-space points into B-space.
	const H = homography(band.outer, outer);
	const inner = band.inner.map(([x, y]) => applyH(H, x, y)) as Corners;
	return { content, inner, outer };
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
 * dark-mat-on-dark-wood ambiguity reads as a lumpy plateau (ratio → 1–2).
 */
export const EDGE_CONFIDENCE_MIN = 3;

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

/**
 * Per-edge outward offsets for the AI matte's alpha clamp: a confident edge (see
 * {@link EDGE_CONFIDENCE_MIN}) is trusted out to the outer (certified-background) quad
 * — the admin drew it well clear of the sleeve, so worn corners, dips and bows anywhere
 * in the band survive. But a confident edge that landed suspiciously close to that outer
 * wall (past `outerProximityMax` of the band's room) is far more likely a false-positive
 * gradient spike (a shadow, a seam) than a sleeve that genuinely grew right up to it, so
 * it's demoted back to the tight low-confidence inset. A genuinely low-confidence edge
 * (no discernible boundary) always gets that same inset: with nothing to see there, a
 * crisp straight cut at the admin's best guess beats trusting the model in the dark.
 */
export function clampEdgeOffsets(
	toOuter: EdgeConfidence,
	toRefined: EdgeConfidence,
	confidence: EdgeConfidence,
	opts: {
		minConfidence: number;
		outerProximityMax: number;
		lowConfInset: number;
	},
): EdgeConfidence {
	return confidence.map((c, e) => {
		const sane =
			c >= opts.minConfidence &&
			toRefined[e] <= toOuter[e] * opts.outerProximityMax;
		return sane ? toOuter[e] : -opts.lowConfInset;
	}) as EdgeConfidence;
}

/**
 * Build a ViTMatte-style trimap (single channel: 0 = definite background, 128 =
 * unknown, 255 = definite foreground) from the picked/refined sleeve `quad`. Erode the
 * quad inward for the definite-foreground core and dilate it outward for the
 * definite-background boundary; the band between is the *only* region the matting model
 * decides. Because the cover interior is locked foreground and the wood beyond the
 * dilated edge is locked background, the model physically can't cut into the artwork's
 * depicted subject or keep a neighbouring record — it just resolves the true edge in the
 * band. Since the admin picks corners *inside* the cover, the true edge sits outward of
 * `quad`, so `dilate` should reach past it into the wood while `erode` stays modest.
 */
export function buildTrimap(
	quad: Corners,
	width: number,
	height: number,
	opts: { erode: EdgeDeltas; dilate: EdgeDeltas },
): Uint8ClampedArray {
	const negate = (d: EdgeDeltas): EdgeDeltas =>
		typeof d === "number"
			? -d
			: ([-d[0], -d[1], -d[2], -d[3]] as [number, number, number, number]);
	const fg = rasterizePolygon(
		offsetQuad(quad, negate(opts.erode)),
		width,
		height,
	);
	const known = rasterizePolygon(offsetQuad(quad, opts.dilate), width, height);
	const trimap = new Uint8ClampedArray(width * height);
	for (let i = 0; i < trimap.length; i++) {
		trimap[i] = fg[i] ? 255 : known[i] ? 128 : 0;
	}
	return trimap;
}

/**
 * Build a trimap directly from a corner band — the hand-drawn ground truth: inside
 * `inner` is locked foreground (certified sleeve), outside `outer` is locked
 * background (certified floor/paper), and the band between is the unknown region the
 * matting model resolves. No erode/dilate guesswork: the admin drew the band.
 */
export function buildTrimapFromBand(
	inner: Corners,
	outer: Corners,
	width: number,
	height: number,
): Uint8ClampedArray {
	const fg = rasterizePolygon(inner, width, height);
	const known = rasterizePolygon(outer, width, height);
	const trimap = new Uint8ClampedArray(width * height);
	for (let i = 0; i < trimap.length; i++) {
		trimap[i] = fg[i] ? 255 : known[i] ? 128 : 0;
	}
	return trimap;
}

/** Point-in-convex-quad test (TL,TR,BR,BL winding, either orientation). */
function insideQuad(quad: Corners, x: number, y: number): boolean {
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

/** Per-channel mean + std of the pixels inside `outer` but outside `inner`. */
function quadRingStats(
	img: RgbaImage,
	outer: Corners,
	inner: Corners,
): {
	n: number;
	mean: [number, number, number];
	std: [number, number, number];
} {
	const { data, width, height } = img;
	const xs = outer.map((c) => c[0]);
	const ys = outer.map((c) => c[1]);
	const x0 = Math.max(0, Math.floor(Math.min(...xs)));
	const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
	const y0 = Math.max(0, Math.floor(Math.min(...ys)));
	const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
	let n = 0;
	const sum = [0, 0, 0];
	const sq = [0, 0, 0];
	for (let y = y0; y <= y1; y += 2) {
		for (let x = x0; x <= x1; x += 2) {
			if (!insideQuad(outer, x, y) || insideQuad(inner, x, y)) continue;
			const i = (y * width + x) * 4;
			for (let c = 0; c < 3; c++) {
				const v = data[i + c];
				sum[c] += v;
				sq[c] += v * v;
			}
			n++;
		}
	}
	if (n === 0) return { n: 0, mean: [0, 0, 0], std: [1, 1, 1] };
	const mean = sum.map((s) => s / n) as [number, number, number];
	// Floor the std so a perfectly uniform backdrop doesn't make distances explode.
	const std = sq.map((s, c) =>
		Math.max(4, Math.sqrt(Math.max(0, s / n - mean[c] * mean[c]))),
	) as [number, number, number];
	return { n, mean, std };
}

/**
 * The last line of defence against background bleeding into the matte: kill alpha for
 * near-edge pixels whose colour decisively matches the *sampled* background rather than
 * the sleeve. Everything upstream (picked corners, edge refine, the matting model) is
 * geometry or texture — when a pick sits a hair onto the floor and the model can't tell
 * dark mat from dark shadowed wood, a background-coloured sliver survives all of it.
 * This veto is colour-statistical and per-capture: the ring just *outside* the cut is
 * ground-truth background and the ring just *inside* the picked quad is ground-truth
 * sleeve border, so it adapts to any backdrop (wood today, white/grey paper after a
 * reshoot) with nothing hardcoded.
 *
 * Deliberately conservative, so it can only remove background — never eat the sleeve:
 *  - it only polices a band `depth` px inside the cut edge, plus — when `bgQuad` is
 *    given — the whole outward band from the cut edge out to `bgQuad` too (the interior
 *    beyond `depth` is always untouched). A confident edge is trusted for the AI matte
 *    out to the outer, certified-background quad (see `clampEdgeOffsets`), so the
 *    model's raw alpha can bleed background anywhere between the true edge and that
 *    outer wall, not just in a thin band hugging the cut — a dark cover's low-contrast
 *    edge region has produced exactly that (wood grain painted in as sleeve well outside
 *    the true edge, confident-scored because most of that edge's scanlines were clean).
 *    Without `bgQuad` (the band-trimap caller, whose `cut` already sits at the certified
 *    outer wall) the policed region stays the original inward-only band;
 *  - it only fires when the two colour distributions are clearly separable (a white
 *    sleeve on white paper is a silent no-op);
 *  - a pixel is vetoed only when it is decisively closer to the background model
 *    (< half the normalised distance) *and* plausibly background in absolute terms.
 *
 * Mutates `mask` (the cut alpha, same dimensions as `img`); returns the vetoed count.
 */
export function vetoBackgroundAlpha(
	img: RgbaImage,
	mask: Uint8ClampedArray,
	/** The quad the mask was cut to — the veto polices a band inside its edges. */
	cut: Corners,
	/** The admin's picked quad — the sleeve-border colour is sampled just inside it. */
	picked: Corners,
	opts: {
		depth: number;
		ring: number;
		gap?: number;
		/**
		 * Sample the background ring outside THIS quad instead of outside `cut`. A band
		 * caller passes the outer quad: everything beyond it is certified background, so
		 * the sample can't be contaminated by an undershot refine.
		 */
		bgQuad?: Corners;
		/**
		 * How far inside `picked` the sleeve-border ring starts (default `depth`). A band
		 * caller passes something small: its inner quad is already certified sleeve, and
		 * a deep inset would sample the artwork instead of the mat border.
		 */
		fgInset?: number;
	},
): number {
	const { data, width, height } = img;
	const gap = opts.gap ?? Math.round(opts.depth * 0.5);
	// Ground-truth background: a ring outside the cut (past a small gap for edge blur),
	// or outside the certified-background quad when the caller has one.
	const bgRef = opts.bgQuad ?? cut;
	const bg = quadRingStats(
		img,
		offsetQuad(bgRef, gap + opts.ring),
		offsetQuad(bgRef, gap),
	);
	// Ground-truth sleeve border: a ring inside the pick, skipping the outer `fgInset`
	// (which may itself be contaminated by the very sliver we're policing).
	const fgInset = opts.fgInset ?? opts.depth;
	const fg = quadRingStats(
		img,
		offsetQuad(picked, -fgInset),
		offsetQuad(picked, -(fgInset + opts.ring)),
	);
	if (bg.n < 64 || fg.n < 64) return 0;
	// If sleeve and background are colourimetrically inseparable (white-on-white),
	// stand down rather than guess.
	let sep = 0;
	for (let c = 0; c < 3; c++) {
		const pooled = Math.sqrt((fg.std[c] ** 2 + bg.std[c] ** 2) / 2);
		sep += ((fg.mean[c] - bg.mean[c]) / pooled) ** 2;
	}
	if (Math.sqrt(sep) < 2) return 0;

	const inner = offsetQuad(cut, -opts.depth);
	// With `bgQuad`, the outward bound is the background wall itself (minus the gap the
	// background ring sampling already reserves, so this stays clear of the ring); without
	// it, the outward bound is `cut` — the original inward-only band.
	const outerBound = opts.bgQuad ? offsetQuad(opts.bgQuad, -gap) : cut;
	const xs = outerBound.map((c) => c[0]);
	const ys = outerBound.map((c) => c[1]);
	const x0 = Math.max(0, Math.floor(Math.min(...xs)));
	const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
	const y0 = Math.max(0, Math.floor(Math.min(...ys)));
	const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
	let vetoed = 0;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const p = y * width + x;
			if (!mask[p]) continue;
			if (insideQuad(inner, x, y) || !insideQuad(outerBound, x, y)) continue;
			const i = p * 4;
			let dBg = 0;
			let dFg = 0;
			for (let c = 0; c < 3; c++) {
				dBg += ((data[i + c] - bg.mean[c]) / bg.std[c]) ** 2;
				dFg += ((data[i + c] - fg.mean[c]) / fg.std[c]) ** 2;
			}
			// Decisively background-like: much closer to the background model than the
			// sleeve's, and within a plausible absolute range of it.
			if (dBg * 4 < dFg && dBg < 25) {
				mask[p] = 0;
				vetoed++;
			}
		}
	}
	return vetoed;
}

// The square cover is warped edge-to-edge with **no** alpha, so it must never sample
// background. It warps straight from the band's INNER quad — certified wholly on the
// sleeve — which retired the old fixed `insetQuadForCover` hack (a 0.5% guess at the
// same thing). Applied identically by the server and the live preview.

export interface MatteOptions {
	/** Output canvas (square) and the sleeve's longer-side size inside it (margin = the gap). */
	canvasSize: number;
	contentSize: number;
	feather?: number;
	tone?: AutoToneOptions | false;
	polish?: { saturation: number; contrast: number; gamma: number };
	shadow?: ShadowOptions;
	/**
	 * How far {@link warpMatteToSquare} straightens the sleeve toward a perfect upright
	 * rectangle: 1 (default) fully squares it, 0 keeps the real photographic perspective,
	 * ~0.5 splits the difference. Ignored by the crop-and-centre {@link frameCutout} tail.
	 */
	straighten?: number;
	/**
	 * Bleed the sleeve's colour this many px into the transparent margin before warping
	 * ({@link bleedEdgeColor}), so the soft edge doesn't pick up the wood just outside it.
	 * Lets the ragged alpha edge stay intact instead of being choked inward.
	 */
	bleed?: number;
}

export interface MatteResult {
	/** The sleeve floating on transparency — a pure cutout. */
	cutout: RgbaImage;
	/** The cutout with a synthesised contact shadow composited underneath. */
	shadow: RgbaImage;
}

/**
 * The shared matte tail, from an already-cut RGBA `cutout` (alpha = the silhouette,
 * any size, transparent everywhere else): crop to the opaque sleeve, scale it so its
 * longer side is `contentSize`, centre it on a transparent `canvasSize` canvas (the
 * even gap is the margin), foreground-tone + polish, and derive the shadow variant.
 * Cropping to the alpha means the sleeve always fills the frame the same way, whatever
 * padding the caller cut it out of.
 */
export function frameCutout(
	cutout: RgbaImage,
	opts: MatteOptions,
): MatteResult {
	const b = alphaBounds(cutout, 16) ?? {
		x: 0,
		y: 0,
		w: cutout.width,
		h: cutout.height,
	};
	const cropped = cropImage(cutout, b.x, b.y, b.w, b.h);
	const scale = opts.contentSize / Math.max(cropped.width, cropped.height);
	const scaled = resizeImage(
		cropped,
		Math.max(1, Math.round(cropped.width * scale)),
		Math.max(1, Math.round(cropped.height * scale)),
	);
	const padded = padToCanvas(scaled, opts.canvasSize);
	const toned: RgbaImage =
		opts.tone === false ? padded : autoTone(padded, opts.tone);
	if (opts.polish) {
		applyPolish(
			toned,
			opts.polish.saturation,
			opts.polish.contrast,
			opts.polish.gamma,
		);
	}
	const framed: RgbaImage = {
		data: toned.data,
		width: toned.width,
		height: toned.height,
	};
	if (!opts.shadow) return { cutout: framed, shadow: framed };
	const shadow = compositeUnder(framed, shadowFromAlpha(framed, opts.shadow));
	return { cutout: framed, shadow };
}

/**
 * Cut `content` (a deskewed, opaque sleeve) to `mask`, feather it, and run the shared
 * {@link frameCutout} tail. The deterministic path passes a clean-quad/edge-snap mask;
 * the matting-model path {@link frameCutout}s its own model-derived cutout directly.
 */
export function composeMatte(
	content: RgbaImage,
	mask: Uint8ClampedArray,
	opts: MatteOptions,
): MatteResult {
	const feathered = featherMask(
		mask,
		content.width,
		content.height,
		opts.feather ?? 2,
	);
	const masked: RgbaImage = {
		data: content.data.slice(),
		width: content.width,
		height: content.height,
	};
	applyMask(masked, feathered);
	return frameCutout(masked, opts);
}

/**
 * Perspective-warp an already-cut sleeve so its (refined) `quad` maps toward an upright
 * rectangle filling the content area — then tone, polish and add a contact shadow. The
 * quad's own edge lengths set the rectangle's aspect ratio, so a near-square sleeve stays
 * near-square and a taller one stays taller. `opts.straighten` (0…1, default 1) blends the
 * destination between the sleeve's own natural (keystoned/tilted) shape and that perfect
 * rectangle: 1 fully squares it, 0 keeps the real photographic perspective, ~0.5 splits
 * the difference — upright-ish but still reading as a physical object, not a flat swatch.
 * `content` must already carry the cutout alpha (transparent outside the sleeve); pixels
 * outside the quad are never shown, since the output beyond it inverse-maps to transparent.
 */
export function warpMatteToSquare(
	content: RgbaImage,
	quad: Corners,
	opts: MatteOptions,
): MatteResult {
	const dist = (a: Corner, b: Corner) => Math.hypot(a[0] - b[0], a[1] - b[1]);
	const w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
	const h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
	const scale = opts.contentSize / Math.max(w, h);
	const rw = Math.max(1, w * scale);
	const rh = Math.max(1, h * scale);
	const ox = (opts.canvasSize - rw) / 2;
	const oy = (opts.canvasSize - rh) / 2;
	const rect: Corners = [
		[ox, oy],
		[ox + rw, oy],
		[ox + rw, oy + rh],
		[ox, oy + rh],
	];
	// The sleeve's own shape, just scaled about its centroid to the same size and centred —
	// keeps the natural keystone/tilt. The destination blends this toward the perfect rect
	// by `straighten`, so a partial warp keeps some real perspective.
	const t = opts.straighten ?? 1;
	const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
	const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
	const cc = opts.canvasSize / 2;
	const dst = rect.map((r, i) => {
		const nx = (quad[i][0] - cx) * scale + cc;
		const ny = (quad[i][1] - cy) * scale + cc;
		return [nx + (r[0] - nx) * t, ny + (r[1] - ny) * t] as Corner;
	}) as Corners;
	// Extend the sleeve's colour into the margin so the warp's edge blend stays off the
	// wood — keeping the ragged alpha edge instead of choking it inward.
	if (opts.bleed) bleedEdgeColor(content, opts.bleed);
	const warped = warpToQuad(
		content,
		quad,
		dst,
		opts.canvasSize,
		opts.canvasSize,
	);
	// Hand off to the shared framing tail: tight-crop to the warped sleeve's alpha bounds,
	// re-fit centred at contentSize, then tone + shadow. This is the same crop the
	// deterministic path uses, so both centre and fill the frame consistently — the warp
	// above only fixes the sleeve's *shape* (straighten), not its size/position.
	return frameCutout(warped, opts);
}

/**
 * Cut `content` to `mask`, feather it, and perspective-warp the result onto an upright
 * rectangle via {@link warpMatteToSquare} — the squared-up floating-sleeve tail shared by
 * the deterministic and Magic matte paths, both of which have a clean refined `quad`.
 *
 * CONSUMES `content`: the mask is applied to its buffer in place (no defensive copy) and
 * `bleedEdgeColor`/the warp mutate it further, so the caller must not read `content` after
 * this returns. Its sole caller ({@link matteFromBand}) passes a fresh {@link deskewBandPadded}
 * buffer it discards immediately — dropping the copy keeps a second ~3000² RGBA (~37 MB)
 * off the heap so the deterministic matte fits a 128 MB isolate on its own.
 */
export function composeMatteWarped(
	content: RgbaImage,
	mask: Uint8ClampedArray,
	quad: Corners,
	opts: MatteOptions,
): MatteResult {
	const feathered = featherMask(
		mask,
		content.width,
		content.height,
		opts.feather ?? 2,
	);
	applyMask(content, feathered);
	return warpMatteToSquare(content, quad, opts);
}

// The deterministic matte deskews with this much surrounding capture (wood) around the
// band's outer quad, so the refine and the veto's background ring have real context.
const MATTE_DETERMINISTIC_PAD = 0.12;
// Erode the cut quad inward by this small fraction of the deskewed frame before
// rasterising, so the rectangle sits a hair inside the found edge — clearing wood / the
// bright paper edge without eating into the cover.
const MATTE_EDGE_INSET = 0.006;

/**
 * The deterministic (free) matte end-to-end: deskew the capture upright with a margin of
 * surrounding capture, find the sleeve's true edge inside the hand-drawn band (searching
 * only between the certified-sleeve inner quad and the certified-background outer quad),
 * cut to that clean rectangle, and run the shared {@link composeMatteWarped} tail. Pure,
 * so the editor preview renders it client-side exactly like the server stores it.
 *
 * A record sleeve *is* a rectangle, and the band already brackets where its edge is — so
 * we fit four straight edges to the real boundary ({@link refineQuadEdgesDetailed})
 * rather than tracing a noisy per-pixel outline. An edge with no clear gradient in the
 * band cuts straight along the band midline (the admin's best guess at the edge).
 * Pass `refine: false` to cut at the midline without any edge search.
 */
export function matteFromBand(
	capture: RgbaImage,
	band: PixelBand,
	opts: MatteOptions & { refine?: boolean },
): MatteResult {
	const outSize = Math.round(
		opts.contentSize / (1 - 2 * MATTE_DETERMINISTIC_PAD),
	);
	const { content, inner, outer } = deskewBandPadded(
		capture,
		band,
		outSize,
		MATTE_DETERMINISTIC_PAD,
	);
	const mid = midQuad(inner, outer);
	const refined =
		opts.refine === false
			? mid
			: refineQuadEdgesDetailed(content, mid, {
					// Search only within the band: the true edge is certified to be in there.
					outward: edgeDistances(mid, outer),
					inward: edgeDistances(mid, inner),
					// Ambiguous edges (no clear gradient) revert to the midline rather
					// than snapping to noise.
					minConfidence: EDGE_CONFIDENCE_MIN,
				}).corners;
	// Bias the cut a hair inside the found edge so wood / the paper edge never shows.
	const quad = offsetQuad(refined, -Math.round(outSize * MATTE_EDGE_INSET));
	const mask = rasterizePolygon(quad, content.width, content.height);
	// Colour-statistical backstop: strip any background-coloured sliver that survived,
	// with both sample rings on certified ground truth — background outside the outer
	// quad, sleeve border just inside the inner quad. No-op when the two colour
	// distributions are inseparable.
	vetoBackgroundAlpha(content, mask, quad, inner, {
		depth: Math.round(outSize * 0.025),
		ring: Math.round(outSize * 0.025),
		bgQuad: outer,
		fgInset: Math.round(outSize * 0.005),
	});
	return composeMatteWarped(content, mask, quad, opts);
}

// ---------- admin matte-quality audit (cheap, non-AI pixel heuristics) ----------

export interface MatteQualityAssessment {
	/** Average per-channel spread (max-min, 0..255) among near-black opaque pixels — a
	 * genuine shadow stays close to neutral even on a saturated cover, so a wide spread
	 * here is the signature of an invented colour cast (see `autoTone`'s white-balance
	 * guards). 0 when there aren't enough shadow pixels to trust a reading. */
	tintScore: number;
	/** Fraction of the canvas's outer margin ring that's unexpectedly opaque — that ring
	 * is meant to stay transparent (it's the shadow's breathing room), so alpha bleeding
	 * into it is the signature of the AI matte's edge clamp overrunning the sleeve (see
	 * `clampEdgeOffsets`). */
	edgeScore: number;
	tintSuspect: boolean;
	edgeSuspect: boolean;
}

/** "Near black" luma cutoff (0..255) for the tint check's shadow sample. */
const AUDIT_SHADOW_LUMA_MAX = 26;
/** Average shadow channel spread (0..255) past which a render is flagged for tint. */
const AUDIT_TINT_SPREAD_SUSPECT = 18;
/** Minimum shadow-pixel sample size before trusting the tint score — avoids noise on a
 * cover with almost no dark content. */
const AUDIT_TINT_MIN_SAMPLE = 200;
/** Outer margin ring width, as a fraction of the shorter canvas side. */
const AUDIT_EDGE_RING_FRAC = 0.015;
/** Fraction of the ring that must be opaque before a render is flagged for edge overrun. */
const AUDIT_EDGE_ALPHA_SUSPECT_FRAC = 0.04;

/**
 * Cheap, non-AI pixel scan of a rendered matte (or any RGBA square with a transparent
 * margin) for the two regression classes the matte pipeline has produced in the past: an
 * invented colour cast on a dark, low-key cover, and the AI matte's alpha overrunning the
 * certified crop into the canvas's outer shadow margin. Pure pixel statistics, no model
 * calls — meant to run over every stored matte cheaply so the admin can shortlist
 * likely-bad renders instead of eyeballing the whole collection. Not exhaustive (a subtle
 * case can still slip through, and a genuinely near-black, hard-edged cover could
 * false-positive) — a shortlist to review, not an authority.
 */
export function assessMatteQuality(img: RgbaImage): MatteQualityAssessment {
	const { data, width, height } = img;

	let spreadSum = 0;
	let shadowN = 0;
	for (let p = 0; p < width * height; p++) {
		if (data[p * 4 + 3] < 16) continue;
		const r = data[p * 4];
		const g = data[p * 4 + 1];
		const b = data[p * 4 + 2];
		const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		if (luma > AUDIT_SHADOW_LUMA_MAX) continue;
		spreadSum += Math.max(r, g, b) - Math.min(r, g, b);
		shadowN++;
	}
	const tintScore = shadowN >= AUDIT_TINT_MIN_SAMPLE ? spreadSum / shadowN : 0;
	const tintSuspect =
		shadowN >= AUDIT_TINT_MIN_SAMPLE && tintScore > AUDIT_TINT_SPREAD_SUSPECT;

	const ring = Math.max(
		1,
		Math.round(Math.min(width, height) * AUDIT_EDGE_RING_FRAC),
	);
	let ringN = 0;
	let ringOpaque = 0;
	for (let y = 0; y < height; y++) {
		const inRingRow = y < ring || y >= height - ring;
		for (let x = 0; x < width; x++) {
			if (!inRingRow && x >= ring && x < width - ring) continue;
			ringN++;
			if (data[(y * width + x) * 4 + 3] >= 16) ringOpaque++;
		}
	}
	const edgeScore = ringN > 0 ? ringOpaque / ringN : 0;
	const edgeSuspect = edgeScore > AUDIT_EDGE_ALPHA_SUSPECT_FRAC;

	return { tintScore, edgeScore, tintSuspect, edgeSuspect };
}
