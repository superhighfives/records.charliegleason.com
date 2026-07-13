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

import type { NormalizedCorners } from "#/lib/sleeve-corners";

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

// ---------- sleeve detection (best-effort seed) ----------

/**
 * Best-effort seed for the corner editor: find the sleeve's axis-aligned bounding box so a
 * freshly captured record opens roughly pre-cropped. Returns normalised corners (TL,TR,BR,
 * BL, 0..1), or `null` for a degenerate result — the caller then falls back to the
 * full-frame default and the admin drags the handles by hand.
 *
 * Works off EDGES, not colour: the sleeve sits on wood and nearly fills the frame, so its
 * four straight borders are the strongest full-width/height luminance transitions near the
 * frame. We build row- and column-gradient profiles and take the strongest peak within the
 * outer band on each side — which is robust to worn/tan sleeve edges and low-contrast
 * artwork (where a colour-difference approach picks up the wrong pixels), and the outer-band
 * limit keeps it from latching onto strong *internal* artwork edges (a tree, a horizon).
 * No perspective — the admin nudges the handles for keystone. Pure and cheap (strided), so
 * it runs on the Worker straight off the capture we already decode for the reframe.
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

	// Gradient energy per row/column: rowGrad peaks on horizontal edges (top/bottom of the
	// sleeve), colGrad on vertical edges (left/right). Summed across the full span, so a
	// full-width sleeve border dominates a short internal edge.
	const cols = Math.ceil(width / stride);
	const rows = Math.ceil(height / stride);
	const rowGrad = new Float64Array(rows);
	const colGrad = new Float64Array(cols);
	for (let y = stride, ry = 1; y < height; y += stride, ry++) {
		for (let x = 0; x < width; x += stride) {
			rowGrad[ry] += Math.abs(lum(x, y) - lum(x, y - stride));
		}
	}
	for (let x = stride, cx = 1; x < width; x += stride, cx++) {
		for (let y = 0; y < height; y += stride) {
			colGrad[cx] += Math.abs(lum(x, y) - lum(x - stride, y));
		}
	}

	// The sleeve edge on each side is the strongest gradient within the outer BAND of that
	// axis (these captures are tightly framed, so an edge is always near the frame; the band
	// also excludes deeper internal artwork edges).
	const BAND = 0.12;
	const argmax = (arr: Float64Array, loF: number, hiF: number): number => {
		const lo = Math.max(1, Math.floor(arr.length * loF));
		const hi = Math.min(arr.length, Math.ceil(arr.length * hiF));
		let bi = lo;
		let bv = -1;
		for (let k = lo; k < hi; k++) {
			if (arr[k] > bv) {
				bv = arr[k];
				bi = k;
			}
		}
		return bi;
	};

	const left = argmax(colGrad, 0, BAND) / cols;
	const right = argmax(colGrad, 1 - BAND, 1) / cols;
	const top = argmax(rowGrad, 0, BAND) / rows;
	const bottom = argmax(rowGrad, 1 - BAND, 1) / rows;

	// Reject an implausible box (edges collapsed together) — not a confident detection.
	if (right - left < 0.4 || bottom - top < 0.4) return null;

	return [
		[left, top],
		[right, top],
		[right, bottom],
		[left, bottom],
	];
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

	const { hist, lumaHist, n } = foregroundStats(img, alphaMin);

	// White-patch balance: line each channel's near-white reference up with the
	// brightest channel's, so whites go neutral while saturated midtones keep their hue.
	const whiteRef = [0, 1, 2].map((c) =>
		Math.max(percentile(hist[c], n, WB_WHITE_PCT), 1),
	);
	const refWhite = Math.max(...whiteRef);
	const wbGain: [number, number, number] = [1, 1, 1];
	for (let c = 0; c < 3; c++) {
		const g = refWhite / whiteRef[c];
		const damped = 1 + (g - 1) * wbStrength;
		wbGain[c] = Math.min(1.6, Math.max(0.625, damped));
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
