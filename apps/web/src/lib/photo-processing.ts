/**
 * Deterministic pixel math for the professional-photo pipeline: turn a rough
 * capture into a straight-on, cropped, evenly-toned square — without a generative
 * model repainting anything. Everything here is pure and operates on plain RGBA
 * buffers ({@link RgbaImage}), so it's trivially unit-testable and has no runtime
 * dependency (the caller decodes/encodes via Photon + the Images binding).
 *
 * The geometry is a classic "document scanner" 4-point perspective correction: the
 * sleeve's four corners (picked by hand in the admin editor) are mapped onto a square via a homography and
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
