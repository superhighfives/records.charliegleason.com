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
 * Refine a starting `quad` (the admin's picked corners, mapped into `img`) to the
 * sleeve's true edges: slide each of the four edges along its outward normal to the
 * offset with the strongest *summed* luminance gradient — the full-length sleeve/wood
 * transition. Because the score sums the whole edge, a local bump (a neighbouring
 * record poking in) or per-pixel noise can't pull it; the result is four clean, straight
 * lines whose intersections are the refined corners. This is why the picked points
 * matter: they say where each edge roughly is, so we only search a band around it.
 */
export function refineQuadEdges(
	img: RgbaImage,
	quad: Corners,
	opts: { search?: number; samples?: number } = {},
): Corners {
	const { width, height, data } = img;
	const samples = opts.samples ?? 64;
	const search = opts.search ?? Math.round(Math.min(width, height) * 0.12);
	const lum = (x: number, y: number): number => {
		const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
		const yi = Math.min(height - 1, Math.max(0, Math.round(y)));
		const i = (yi * width + xi) * 4;
		return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
	};
	const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
	const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
	// The four (shifted) edge lines, each as two points.
	const lines: Array<[Corner, Corner]> = [];
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
		// Mostly outward (the picked corners sit inside the cover), a little inward.
		for (let d = -Math.round(search * 0.5); d <= search; d++) {
			let score = 0;
			for (let s = 0; s < samples; s++) {
				const t = (s + 0.5) / samples;
				const px = ax + ex * t + nx * d;
				const py = ay + ey * t + ny * d;
				score += Math.abs(lum(px + nx, py + ny) - lum(px - nx, py - ny));
			}
			if (score > bestScore) {
				bestScore = score;
				bestDelta = d;
			}
		}
		lines.push([
			[ax + nx * bestDelta, ay + ny * bestDelta],
			[bx + nx * bestDelta, by + ny * bestDelta],
		]);
	}
	// Corner i is where edge (i-1) meets edge i.
	return [0, 1, 2, 3].map((i) => {
		const prev = lines[(i + 3) % 4];
		const cur = lines[i];
		return lineIntersect(prev[0], prev[1], cur[0], cur[1]);
	}) as Corners;
}

/**
 * Shift each of the quad's four edges by `delta` px along its outward normal (positive
 * `delta` = dilate outward, negative = erode inward), then intersect adjacent shifted
 * lines for the new corners — a clean geometric grow/shrink that keeps the rectangle a
 * rectangle. Used to bracket the true sleeve edge when building a trimap from the picked
 * corners.
 */
export function offsetQuad(quad: Corners, delta: number): Corners {
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
		lines.push([
			[ax + nx * delta, ay + ny * delta],
			[bx + nx * delta, by + ny * delta],
		]);
	}
	return [0, 1, 2, 3].map((i) => {
		const prev = lines[(i + 3) % 4];
		const cur = lines[i];
		return lineIntersect(prev[0], prev[1], cur[0], cur[1]);
	}) as Corners;
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
	opts: { erode: number; dilate: number },
): Uint8ClampedArray {
	const fg = rasterizePolygon(offsetQuad(quad, -opts.erode), width, height);
	const known = rasterizePolygon(offsetQuad(quad, opts.dilate), width, height);
	const trimap = new Uint8ClampedArray(width * height);
	for (let i = 0; i < trimap.length; i++) {
		trimap[i] = fg[i] ? 255 : known[i] ? 128 : 0;
	}
	return trimap;
}

export interface MatteOptions {
	/** Output canvas (square) and the sleeve's longer-side size inside it (margin = the gap). */
	canvasSize: number;
	contentSize: number;
	feather?: number;
	tone?: AutoToneOptions | false;
	polish?: { saturation: number; contrast: number; gamma: number };
	shadow?: ShadowOptions;
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
 * Perspective-warp an already-cut sleeve so its (refined) `quad` maps onto an upright
 * rectangle filling the content area — a clean, front-on floating sleeve rather than the
 * tilted/keystoned capture — then tone, polish and add a contact shadow. The quad's own
 * edge lengths set the rectangle's aspect ratio, so a near-square sleeve stays near-square
 * and a taller one stays taller. `content` must already carry the cutout alpha
 * (transparent outside the sleeve); pixels outside the quad are never shown, since the
 * output beyond the rectangle inverse-maps to that transparent surround.
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
	const warped = warpToQuad(
		content,
		quad,
		rect,
		opts.canvasSize,
		opts.canvasSize,
	);
	const toned: RgbaImage =
		opts.tone === false ? warped : autoTone(warped, opts.tone);
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
 * Cut `content` to `mask`, feather it, and perspective-warp the result onto an upright
 * rectangle via {@link warpMatteToSquare} — the squared-up floating-sleeve tail shared by
 * the deterministic and AI matte paths, both of which have a clean refined `quad`.
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
	const masked: RgbaImage = {
		data: content.data.slice(),
		width: content.width,
		height: content.height,
	};
	applyMask(masked, feathered);
	return warpMatteToSquare(masked, quad, opts);
}

// The deterministic matte deskews with this much surrounding capture (wood) around the
// picked quad, so {@link refineQuadEdges} has a band to search outward into for the true
// sleeve edge — since the admin picks corners *inside* the cover.
const MATTE_DETERMINISTIC_PAD = 0.12;

/**
 * The deterministic (free) matte end-to-end: deskew the capture upright with a margin of
 * surrounding capture, refine the picked quad out to the sleeve's true edges, cut to
 * that clean rectangle, and run the shared {@link composeMatte} tail. Pure, so the editor
 * preview renders it client-side exactly like the server stores it.
 *
 * A record sleeve *is* a rectangle, and the picked corners already say where it is — so
 * we fit four straight edges to the real boundary ({@link refineQuadEdges}) rather than
 * tracing a noisy per-pixel outline or trusting a segmentation model to respect the
 * rectangle. Pass `refine: false` to fall back to the raw picked quad (no edge search).
 */
export function matteFromCorners(
	capture: RgbaImage,
	corners: Corners,
	opts: MatteOptions & { refine?: boolean },
): MatteResult {
	const outSize = Math.round(
		opts.contentSize / (1 - 2 * MATTE_DETERMINISTIC_PAD),
	);
	const { content, corners: inset } = deskewContentPadded(
		capture,
		corners,
		outSize,
		MATTE_DETERMINISTIC_PAD,
	);
	const quad =
		opts.refine === false
			? inset
			: refineQuadEdges(content, inset, {
					search: Math.round(outSize * MATTE_DETERMINISTIC_PAD),
				});
	const mask = rasterizePolygon(quad, content.width, content.height);
	return composeMatteWarped(content, mask, quad, opts);
}
