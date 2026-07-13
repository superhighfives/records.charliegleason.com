/**
 * Deterministic pixel math for the professional-photo pipeline: turn a rough
 * capture into a straight-on, cropped, evenly-toned square — without a generative
 * model repainting anything. Everything here is pure and operates on plain RGBA
 * buffers ({@link RgbaImage}), so it's trivially unit-testable and has no runtime
 * dependency (the caller decodes/encodes via Photon + the Images binding).
 *
 * The geometry is a classic "document scanner" 4-point perspective correction: the
 * sleeve's four corners (found from the cutout's alpha) are mapped onto a square via
 * a homography and inverse-sampled, which crops, squares and de-keystones in one
 * step. The tone is a foreground-aware auto-levels + grey-world white balance, so a
 * dark capture and a bright one come out consistent and neutral.
 */

export interface RgbaImage {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

/** A corner as [x, y] in pixel coordinates. */
export type Corner = [number, number];
/** Four corners in TL, TR, BR, BL order (clockwise from top-left). */
export type Corners = [Corner, Corner, Corner, Corner];

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
	const dst: Corners = [
		[0, 0],
		[size - 1, 0],
		[size - 1, size - 1],
		[0, size - 1],
	];
	const H = homography(dst, corners); // output -> source
	const data = new Uint8ClampedArray(size * size * 4);
	const px: [number, number, number, number] = [0, 0, 0, 0];
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const [sx, sy] = applyH(H, x, y);
			sampleBilinear(src, sx, sy, px);
			const i = (y * size + x) * 4;
			data[i] = px[0];
			data[i + 1] = px[1];
			data[i + 2] = px[2];
			data[i + 3] = px[3];
		}
	}
	return { data, width: size, height: size };
}

// ---------- corner detection from an alpha mask ----------

/**
 * Find the sleeve's four corners (TL,TR,BR,BL) from a cutout's alpha channel by
 * taking the extremes of x+y (→ TL/BR) and x-y (→ TR/BL). Robust for a convex quad
 * under mild rotation; on an axis-aligned sleeve it collapses to the bounding box.
 * `alphaMin` ignores the anti-aliased matte fringe. Returns null if nothing is
 * opaque enough to be the sleeve.
 */
export function cornersFromMask(
	mask: RgbaImage,
	alphaMin = 16,
): Corners | null {
	const { data, width, height } = mask;
	let tl: Corner | undefined;
	let tr: Corner | undefined;
	let br: Corner | undefined;
	let bl: Corner | undefined;
	let sMin = Infinity;
	let sMax = -Infinity;
	let dMin = Infinity;
	let dMax = -Infinity;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] < alphaMin) continue;
			const s = x + y;
			const d = x - y;
			if (s < sMin) {
				sMin = s;
				tl = [x, y];
			}
			if (s > sMax) {
				sMax = s;
				br = [x, y];
			}
			if (d > dMax) {
				dMax = d;
				tr = [x, y];
			}
			if (d < dMin) {
				dMin = d;
				bl = [x, y];
			}
		}
	}
	if (!tl || !tr || !br || !bl) return null;
	return [tl, tr, br, bl];
}

/** The axis-aligned bounding rectangle of the mask, as TL,TR,BR,BL corners. */
export function bboxFromMask(mask: RgbaImage, alphaMin = 16): Corners | null {
	const { data, width, height } = mask;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] < alphaMin) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (maxX < minX || maxY < minY) return null;
	return [
		[minX, minY],
		[maxX, minY],
		[maxX, maxY],
		[minX, maxY],
	];
}

/**
 * Whether the detected quad is trustworthy enough to perspective-warp. A vinyl
 * sleeve is square and roughly frontal, so we reject quads that are too small,
 * badly keystoned, or far from square — the caller then falls back to a plain
 * bounding-box crop (no perspective) rather than warping to a bad shape.
 */
export function isQuadTrustworthy(
	corners: Corners | null,
	width: number,
	height: number,
): corners is Corners {
	if (!corners) return false;
	const [tl, tr, br, bl] = corners;
	const dist = (a: Corner, b: Corner) => Math.hypot(a[0] - b[0], a[1] - b[1]);
	const top = dist(tl, tr);
	const bottom = dist(bl, br);
	const left = dist(tl, bl);
	const right = dist(tr, br);
	const minSide = Math.min(top, bottom, left, right);
	if (minSide < 0.25 * Math.min(width, height)) return false;
	if (Math.max(top, bottom) / Math.min(top, bottom) > 1.35) return false;
	if (Math.max(left, right) / Math.min(left, right) > 1.35) return false;
	const aspect = (top + bottom) / (left + right); // ~1 for a square sleeve
	if (aspect < 0.7 || aspect > 1.3) return false;
	return true;
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

// ---------- tone: auto-levels + grey-world white balance ----------

interface ForegroundStats {
	hist: [Uint32Array, Uint32Array, Uint32Array];
	mean: [number, number, number];
	n: number;
}

/** Per-channel histograms + means over opaque (foreground) pixels only. */
function foregroundStats(img: RgbaImage, alphaMin: number): ForegroundStats {
	const { data, width, height } = img;
	const hist: [Uint32Array, Uint32Array, Uint32Array] = [
		new Uint32Array(256),
		new Uint32Array(256),
		new Uint32Array(256),
	];
	const sum: [number, number, number] = [0, 0, 0];
	let n = 0;
	for (let p = 0; p < width * height; p++) {
		if (data[p * 4 + 3] < alphaMin) continue;
		n++;
		for (let c = 0; c < 3; c++) {
			const v = data[p * 4 + c];
			hist[c][v]++;
			sum[c] += v;
		}
	}
	return {
		hist,
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
	/** Low/high percentiles clipped to black/white when stretching levels. */
	lowPct?: number;
	highPct?: number;
	/** 0 = no white balance, 1 = full grey-world correction. */
	wbStrength?: number;
	/** Target normalised mean luma after levels (0..1); drives one global gamma. */
	targetMid?: number;
}

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
 * Foreground-aware auto-levels + grey-world white balance in one pass:
 *  - white balance scales each channel so its mean approaches the overall grey mean
 *    (removes an ambient colour cast), damped by `wbStrength` and clamped so it
 *    never swings wildly;
 *  - levels stretch each channel's [lowPct, highPct] to [0,255];
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

	const { hist, mean, n } = foregroundStats(img, alphaMin);
	const greyMean = (mean[0] + mean[1] + mean[2]) / 3;

	const wbGain: [number, number, number] = [1, 1, 1];
	for (let c = 0; c < 3; c++) {
		const g = greyMean / Math.max(mean[c], 1);
		const damped = 1 + (g - 1) * wbStrength;
		wbGain[c] = Math.min(1.6, Math.max(0.625, damped));
	}

	const lo = [0, 1, 2].map((c) => percentile(hist[c], n, lowPct));
	const hi = [0, 1, 2].map((c) => percentile(hist[c], n, highPct));

	// LUT per channel: white-balance gain then levels stretch. A channel with no
	// usable spread (a near-uniform region) would otherwise collapse to black, so we
	// skip the stretch and just apply the balance gain there.
	const lut = [0, 1, 2].map((c) => {
		const table = new Uint8ClampedArray(256);
		const span = hi[c] - lo[c];
		for (let v = 0; v < 256; v++) {
			const balanced = v * wbGain[c];
			table[v] = span < 1 ? balanced : ((balanced - lo[c]) / span) * 255;
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
 * The full deterministic reframe: given a straight-alpha cutout, detect the sleeve,
 * perspective-warp it to a square (or bbox-crop as a fallback), pad to the canvas,
 * and auto-tone. Returns the final RGBA plus which geometry path was taken.
 */
export function reframeSquare(
	cutout: RgbaImage,
	opts: {
		canvasSize: number;
		contentSize: number;
		// Auto-tone options, or `false` to skip the tone stage entirely and keep the
		// warped capture's original exposure/colour (a diagnostic path — the levels +
		// white-balance + gamma stretch can amplify real surface sheen into a hard
		// highlight, so being able to compare untoned output is useful).
		tone?: AutoToneOptions | false;
	},
): { image: RgbaImage; perspective: boolean } {
	const detected = cornersFromMask(cutout);
	let corners: Corners;
	let perspective: boolean;
	if (isQuadTrustworthy(detected, cutout.width, cutout.height)) {
		corners = detected;
		perspective = true;
	} else {
		const bbox = bboxFromMask(cutout);
		if (!bbox) {
			// Nothing opaque — return a transparent canvas rather than throwing.
			return {
				image: {
					data: new Uint8ClampedArray(opts.canvasSize * opts.canvasSize * 4),
					width: opts.canvasSize,
					height: opts.canvasSize,
				},
				perspective: false,
			};
		}
		corners = bbox;
		perspective = false;
	}
	const content = warpToSquare(cutout, corners, opts.contentSize);
	const padded = padToCanvas(content, opts.canvasSize);
	const framed = opts.tone === false ? padded : autoTone(padded, opts.tone);
	return {
		image: { data: framed.data, width: framed.width, height: framed.height },
		perspective,
	};
}
