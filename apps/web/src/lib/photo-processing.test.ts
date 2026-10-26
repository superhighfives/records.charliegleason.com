import { describe, expect, it } from "vitest";
import {
	autoTone,
	type Corners,
	detectSleeveCorners,
	edgeDistances,
	homography,
	midQuad,
	offsetQuad,
	padToCanvas,
	type RgbaImage,
	refineQuadEdges,
	refineQuadEdgesDetailed,
	reframeFromCorners,
	warpToQuad,
	warpToSquare,
} from "./photo-processing";

/** A checkerboard "sleeve" — the ground truth we warp and try to recover. */
function checkerboard(size: number, cells = 8): RgbaImage {
	const data = new Uint8ClampedArray(size * size * 4);
	const cs = size / cells;
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const on = (Math.floor(x / cs) + Math.floor(y / cs)) % 2 === 0;
			const i = (y * size + x) * 4;
			data[i] = on ? 230 : 40;
			data[i + 1] = on ? 80 : 40;
			data[i + 2] = on ? 60 : 200;
			data[i + 3] = 255;
		}
	return { data, width: size, height: size };
}

function applyH(H: number[], x: number, y: number): [number, number] {
	const w = H[6] * x + H[7] * y + H[8];
	return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function pointInQuad(px: number, py: number, q: Corners): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const [ax, ay] = q[i];
		const [bx, by] = q[(i + 1) % 4];
		const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
		const s = Math.sign(cross);
		if (s !== 0) {
			if (sign === 0) sign = s;
			else if (s !== sign) return false;
		}
	}
	return true;
}

/**
 * Paste a sleeve into a bigger, fully-opaque capture under a known perspective — the
 * raw-photo input the corner editor works from (background is opaque wood, not a matte).
 */
function synthCapture(sleeve: RgbaImage, canvas: number, corners: Corners) {
	const size = sleeve.width;
	const Hcs = homography(corners, [
		[0, 0],
		[size - 1, 0],
		[size - 1, size - 1],
		[0, size - 1],
	]);
	const data = new Uint8ClampedArray(canvas * canvas * 4);
	for (let y = 0; y < canvas; y++)
		for (let x = 0; x < canvas; x++) {
			const i = (y * canvas + x) * 4;
			if (pointInQuad(x, y, corners)) {
				const [sx, sy] = applyH(Hcs, x, y);
				const xi = Math.max(0, Math.min(size - 1, Math.round(sx)));
				const yi = Math.max(0, Math.min(size - 1, Math.round(sy)));
				const si = (yi * size + xi) * 4;
				data[i] = sleeve.data[si];
				data[i + 1] = sleeve.data[si + 1];
				data[i + 2] = sleeve.data[si + 2];
			} else {
				data[i] = 120;
				data[i + 1] = 90;
				data[i + 2] = 60;
			}
			data[i + 3] = 255; // the whole capture is opaque
		}
	return { data, width: canvas, height: canvas };
}

describe("warpToSquare", () => {
	it("recovers the original sleeve by un-warping a known quad", () => {
		const size = 512;
		const corners: Corners = [
			[140, 90],
			[770, 160],
			[810, 740],
			[95, 690],
		];
		const sleeve = checkerboard(size);
		const cap = synthCapture(sleeve, 900, corners);
		const recovered = warpToSquare(cap, corners, size);

		let se = 0;
		for (let p = 0; p < size * size; p++)
			for (let c = 0; c < 3; c++) {
				const d = recovered.data[p * 4 + c] - sleeve.data[p * 4 + c];
				se += d * d;
			}
		const rmse = Math.sqrt(se / (size * size * 3));
		expect(rmse).toBeLessThan(15); // essentially perfect bar resampling
	});
});

describe("autoTone", () => {
	it("brightens a dark foreground toward the mid target and ignores the transparent margin", () => {
		const size = 64;
		const data = new Uint8ClampedArray(size * size * 4);
		for (let p = 0; p < size * size; p++) {
			const x = p % size;
			// left half opaque + dark, right half transparent + bright (should be ignored)
			if (x < size / 2) {
				data[p * 4] = 40;
				data[p * 4 + 1] = 40;
				data[p * 4 + 2] = 40;
				data[p * 4 + 3] = 255;
			} else {
				data[p * 4] = 250;
				data[p * 4 + 1] = 250;
				data[p * 4 + 2] = 250;
				data[p * 4 + 3] = 0;
			}
		}
		const toned = autoTone(
			{ data, width: size, height: size },
			{ targetMid: 0.5 },
		);
		// foreground mean luma should move up toward the target
		let sum = 0;
		let n = 0;
		for (let p = 0; p < size * size; p++) {
			if (toned.data[p * 4 + 3] < 16) continue;
			sum += toned.data[p * 4];
			n++;
		}
		expect(sum / n).toBeGreaterThan(40);
		// alpha is preserved
		expect(toned.data[3]).toBe(255);
	});

	it("doesn't invent a colour cast on a dark, low-key cover with no true white point", () => {
		// Regression for the Parachutes orange-tint bug: a mostly-dark, near-neutral
		// foreground where the only "bright" pixels are a small noisy cluster — nowhere
		// near an actual white. Naively trusting that cluster as a white-balance
		// reference pushes the WHOLE dark bulk toward the opposite colour.
		const size = 64;
		const n = size * size;
		const data = new Uint8ClampedArray(n * 4);
		for (let p = 0; p < n; p++) {
			const bright = p % 20 === 0; // ~5% of pixels
			const [r, g, b] = bright ? [60, 45, 30] : [15, 15, 15];
			data[p * 4] = r;
			data[p * 4 + 1] = g;
			data[p * 4 + 2] = b;
			data[p * 4 + 3] = 255;
		}
		const toned = autoTone({ data, width: size, height: size });
		// White balance should stay close to unity — there's no plausible white
		// reference here, so the gain shouldn't chase the noisy highlight cluster.
		for (const gain of toned.debug.wbGain) expect(gain).toBeLessThan(1.15);
		// A bulk (originally neutral) pixel should stay close to neutral, not pick up a
		// hue shift from an over-eager white-balance correction.
		const bulkIdx = 1; // p=1 is not a multiple of 20, so it's a "dark" pixel
		const r = toned.data[bulkIdx * 4];
		const g = toned.data[bulkIdx * 4 + 1];
		const b = toned.data[bulkIdx * 4 + 2];
		expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(15);
	});
});

describe("detectSleeveCorners", () => {
	/** A `size` image: uniform `bg`, with a solid `fg` rectangle in [x0,x1)×[y0,y1). */
	function rectOnBg(
		size: number,
		bg: [number, number, number],
		fg: [number, number, number],
		box: [number, number, number, number],
	): RgbaImage {
		const data = new Uint8ClampedArray(size * size * 4);
		const [x0, y0, x1, y1] = box;
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
				const [r, g, b] = inside ? fg : bg;
				const i = (y * size + x) * 4;
				data[i] = r;
				data[i + 1] = g;
				data[i + 2] = b;
				data[i + 3] = 255;
			}
		return { data, width: size, height: size };
	}

	it("finds the sleeve's edges when it nearly fills the frame", () => {
		// A bright sleeve on dark wood, edges at 8%/92% — within the outer band the
		// edge detector searches; its four borders are the strongest gradients there.
		const img = rectOnBg(
			400,
			[40, 40, 40],
			[200, 200, 200],
			[32, 32, 368, 368],
		);
		const c = detectSleeveCorners(img);
		if (!c) throw new Error("expected a detection");
		const [tl, tr, , bl] = c;
		expect(tl[0]).toBeCloseTo(0.08, 1); // left
		expect(tr[0]).toBeCloseTo(0.92, 1); // right
		expect(tl[1]).toBeCloseTo(0.08, 1); // top
		expect(bl[1]).toBeCloseTo(0.92, 1); // bottom
	});

	/** A `w`×`h` image: uniform `bg` with a solid `fg` rectangle in [x0,x1)×[y0,y1). */
	function rectImg(
		w: number,
		h: number,
		bg: [number, number, number],
		fg: [number, number, number],
		box: [number, number, number, number],
	): RgbaImage {
		const data = new Uint8ClampedArray(w * h * 4);
		const [x0, y0, x1, y1] = box;
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
				const [r, g, b] = inside ? fg : bg;
				const i = (y * w + x) * 4;
				data[i] = r;
				data[i + 1] = g;
				data[i + 2] = b;
				data[i + 3] = 255;
			}
		return { data, width: w, height: h };
	}

	it("detects on a real-world size whose band boundary isn't a whole pixel", () => {
		// Regression: the right/bottom scan starts at size*(1-BAND), which for most capture
		// sizes isn't an integer. A fractional buffer index reads as NaN, which used to make
		// those two sides collect zero points and bail the whole detector to null on every
		// non-400²-aligned capture. 513×389 lands both boundaries off a whole pixel.
		const img = rectImg(
			513,
			389,
			[40, 40, 40],
			[200, 200, 200],
			[41, 31, 472, 358], // ~8%/92% on each axis
		);
		const c = detectSleeveCorners(img);
		if (!c) throw new Error("expected a detection, not null");
		const [tl, tr, , bl] = c;
		expect(tl[0]).toBeCloseTo(0.08, 1); // left
		expect(tr[0]).toBeCloseTo(0.92, 1); // right
		expect(tl[1]).toBeCloseTo(0.08, 1); // top
		expect(bl[1]).toBeCloseTo(0.92, 1); // bottom
	});

	it("returns null for an image too small to detect", () => {
		const img = rectOnBg(30, [40, 40, 40], [200, 200, 200], [4, 4, 26, 26]);
		expect(detectSleeveCorners(img)).toBeNull();
	});

	/** A `size` image: uniform `bg` with a solid `fg` convex quad (pixel corners). */
	function quadOnBg(
		size: number,
		bg: [number, number, number],
		fg: [number, number, number],
		quad: [Corners[number], Corners[number], Corners[number], Corners[number]],
	): RgbaImage {
		const data = new Uint8ClampedArray(size * size * 4);
		// Sign-of-cross point-in-convex-polygon test (as in sleeve-corners' insideQuadNorm).
		const inside = (px: number, py: number) => {
			let sign = 0;
			for (let e = 0; e < 4; e++) {
				const [ax, ay] = quad[e];
				const [bx, by] = quad[(e + 1) % 4];
				const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
				if (cross === 0) continue;
				const s = cross > 0 ? 1 : -1;
				if (sign === 0) sign = s;
				else if (s !== sign) return false;
			}
			return true;
		};
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const [r, g, b] = inside(x, y) ? fg : bg;
				const i = (y * size + x) * 4;
				data[i] = r;
				data[i + 1] = g;
				data[i + 2] = b;
				data[i + 3] = 255;
			}
		return { data, width: size, height: size };
	}

	it("recovers a tilted (non-axis-aligned) sleeve quad", () => {
		// A sleeve rotated/keystoned on the table: the top edge slopes up to the right and
		// the sides lean. Each border still sits within the outer search band.
		const img = quadOnBg(
			400,
			[40, 40, 40],
			[200, 200, 200],
			[
				[44, 52], // TL
				[360, 30], // TR
				[372, 356], // BR
				[30, 348], // BL
			],
		);
		const c = detectSleeveCorners(img);
		if (!c) throw new Error("expected a detection");
		const [tl, tr, br, bl] = c;
		// Corners land near the true quad (within a couple of percent of the frame).
		expect(tl[0]).toBeCloseTo(44 / 399, 1);
		expect(tl[1]).toBeCloseTo(52 / 399, 1);
		expect(tr[0]).toBeCloseTo(360 / 399, 1);
		expect(tr[1]).toBeCloseTo(30 / 399, 1);
		expect(br[1]).toBeCloseTo(356 / 399, 1);
		expect(bl[0]).toBeCloseTo(30 / 399, 1);
		// The recovered quad is genuinely tilted, not the old axis-aligned box: the top
		// edge rises to the right (TR above TL) and the bottom drops to the right.
		expect(tr[1]).toBeLessThan(tl[1]);
		expect(br[1]).toBeGreaterThan(bl[1]);
	});

	/**
	 * A `size` image with a sharp box everywhere except one side, where the transition from
	 * `fg` to `bg` is spread linearly over `rampPx` on either side of the true edge — a soft
	 * shadow or out-of-focus boundary instead of a one-pixel step.
	 */
	function rectWithSoftEdge(
		size: number,
		bg: [number, number, number],
		fg: [number, number, number],
		box: [number, number, number, number],
		side: "bottom",
		rampPx: number,
	): RgbaImage {
		const data = new Uint8ClampedArray(size * size * 4);
		const [x0, y0, x1, y1] = box;
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				let rgb: [number, number, number];
				const inX = x >= x0 && x < x1;
				if (side === "bottom" && inX && y >= y1 - rampPx && y < y1 + rampPx) {
					const t = (y - (y1 - rampPx)) / (2 * rampPx);
					rgb = [0, 1, 2].map((c) => fg[c] + (bg[c] - fg[c]) * t) as [
						number,
						number,
						number,
					];
				} else {
					rgb = x >= x0 && x < x1 && y >= y0 && y < y1 ? fg : bg;
				}
				const i = (y * size + x) * 4;
				data[i] = rgb[0];
				data[i + 1] = rgb[1];
				data[i + 2] = rgb[2];
				data[i + 3] = 255;
			}
		}
		return { data, width: size, height: size };
	}

	it("finds a boundary blurred by a soft shadow, not just a hard step", () => {
		// The bottom border isn't a one-pixel step — it ramps from sleeve to background over
		// 40px either side of the true edge, as a drop shadow or out-of-focus edge would. A
		// derivative that only compares two adjacent samples dilutes across a ramp this wide
		// and can miss the side's confidence gate entirely.
		const img = rectWithSoftEdge(
			400,
			[170, 165, 145],
			[215, 70, 73],
			[32, 32, 368, 368],
			"bottom",
			40,
		);
		const c = detectSleeveCorners(img);
		if (!c) throw new Error("expected a detection");
		const [, , br, bl] = c;
		expect(bl[1]).toBeCloseTo(0.92, 1);
		expect(br[1]).toBeCloseTo(0.92, 1);
	});
});

describe("reframeFromCorners", () => {
	it("perspective-warps the quad and pads to the canvas", () => {
		const cap = synthCapture(checkerboard(512), 900, [
			[140, 90],
			[770, 160],
			[810, 740],
			[95, 690],
		]);
		const { image } = reframeFromCorners(
			cap,
			[
				[140, 90],
				[770, 160],
				[810, 740],
				[95, 690],
			],
			{ canvasSize: 200, contentSize: 180 },
		);
		expect(image.width).toBe(200);
		expect(image.height).toBe(200);
		// centre is opaque sleeve, extreme corner is transparent margin
		const centre = (100 * 200 + 100) * 4;
		expect(image.data[centre + 3]).toBeGreaterThan(200);
		expect(image.data[3]).toBe(0);
	});

	it("tone: false skips auto-tone (raw warp+pad), default applies it", () => {
		// A dark horizontal gradient sleeve: it has real tonal spread, so default
		// auto-tone visibly stretches/brightens it — while tone:false must return the
		// warped-and-padded pixels verbatim, with no tone stage at all.
		const s = 512;
		const grad = new Uint8ClampedArray(s * s * 4);
		for (let y = 0; y < s; y++)
			for (let x = 0; x < s; x++) {
				const v = 20 + Math.round((x / (s - 1)) * 80); // 20..100, dark
				const i = (y * s + x) * 4;
				grad[i] = grad[i + 1] = grad[i + 2] = v;
				grad[i + 3] = 255;
			}
		const corners: Corners = [
			[140, 90],
			[770, 160],
			[810, 740],
			[95, 690],
		];
		const cap = synthCapture({ data: grad, width: s, height: s }, 900, corners);
		const opts = { canvasSize: 200, contentSize: 180 };

		const raw = reframeFromCorners(cap, corners, { ...opts, tone: false });
		// tone:false must be byte-identical to a bare warp→pad, proving no tone ran.
		const bare = padToCanvas(
			warpToSquare(cap, corners, opts.contentSize),
			opts.canvasSize,
		);
		expect(raw.image.data).toEqual(bare.data);

		// The default (toned) output must differ — auto-tone changed the pixels.
		const toned = reframeFromCorners(cap, corners, opts);
		expect(toned.image.data).not.toEqual(raw.image.data);
	});
});

describe("warpToQuad", () => {
	it("is byte-identical to warpToSquare for a square destination", () => {
		const corners: Corners = [
			[140, 90],
			[770, 160],
			[810, 740],
			[95, 690],
		];
		const cap = synthCapture(checkerboard(256), 900, corners);
		const size = 200;
		const viaQuad = warpToQuad(
			cap,
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
		expect(viaQuad.data).toEqual(warpToSquare(cap, corners, size).data);
	});
});

describe("refineQuadEdges", () => {
	it("expands an inset quad out to the true rectangle edges", () => {
		// A bright rectangle [40,160)² on a dark field. Start from a quad picked *inside*
		// it; refinement should push each edge out to the real ~40/160 boundary.
		const size = 200;
		const data = new Uint8ClampedArray(size * size * 4);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const inside = x >= 40 && x < 160 && y >= 40 && y < 160;
				const i = (y * size + x) * 4;
				data[i] = data[i + 1] = data[i + 2] = inside ? 220 : 30;
				data[i + 3] = 255;
			}
		const inset: Corners = [
			[60, 60],
			[140, 60],
			[140, 140],
			[60, 140],
		];
		const refined = refineQuadEdges(
			{ data, width: size, height: size },
			inset,
			{ search: 40 },
		);
		// Each corner should land near the true (40,40)…(160,160) rectangle.
		for (const [x, y] of refined) {
			expect(Math.min(Math.abs(x - 40), Math.abs(x - 160))).toBeLessThan(4);
			expect(Math.min(Math.abs(y - 40), Math.abs(y - 160))).toBeLessThan(4);
		}
	});

	it("keeps to the true edge instead of a stronger seam further out", () => {
		// The sleeve rect [40,160)² (value 200) on wood (60), plus a *brighter* vertical
		// seam at x∈[176,180) (value 255) just outside the right edge — a wood-plank line
		// in the floor. Its gradient (195) beats the sleeve's own right edge (140), so an
		// unweighted search snaps the right edge out onto it and drags a wood strip into
		// the cutout. Proximity weighting must keep the right edge at the true ~160.
		const size = 220;
		const data = new Uint8ClampedArray(size * size * 4);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const inRect = x >= 40 && x < 160 && y >= 40 && y < 160;
				const inSeam = x >= 176 && x < 180 && y >= 40 && y < 160;
				const v = inSeam ? 255 : inRect ? 200 : 60;
				const i = (y * size + x) * 4;
				data[i] = data[i + 1] = data[i + 2] = v;
				data[i + 3] = 255;
			}
		const inset: Corners = [
			[55, 55],
			[145, 55],
			[145, 145],
			[55, 145],
		];
		const refined = refineQuadEdges(
			{ data, width: size, height: size },
			inset,
			{
				search: 40,
			},
		);
		// The right-edge corners (indices 1, 2) must stay at the true edge (~160), not the
		// seam near 178.
		expect(Math.abs(refined[1][0] - 160)).toBeLessThan(5);
		expect(Math.abs(refined[2][0] - 160)).toBeLessThan(5);
	});

	it("finds a chroma-only edge that has no luminance step", () => {
		// A warm rectangle on a cool field with (near-)identical luminance — the
		// dark-charcoal-mat-on-dark-shadowed-wood case. A luma-only gradient sees
		// nothing here; the per-channel colour gradient must still snap to the edge.
		// luma(150,60,50) ≈ 78.4 vs luma(40,95,95) ≈ 83.3 — a ~5/255 luma step, but a
		// |ΔR|+|ΔG|+|ΔB| step of 190.
		const size = 200;
		const data = new Uint8ClampedArray(size * size * 4);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const inside = x >= 40 && x < 160 && y >= 40 && y < 160;
				const i = (y * size + x) * 4;
				data[i] = inside ? 150 : 40;
				data[i + 1] = inside ? 60 : 95;
				data[i + 2] = inside ? 50 : 95;
				data[i + 3] = 255;
			}
		const inset: Corners = [
			[60, 60],
			[140, 60],
			[140, 140],
			[60, 140],
		];
		const refined = refineQuadEdges(
			{ data, width: size, height: size },
			inset,
			{ search: 40 },
		);
		for (const [x, y] of refined) {
			expect(Math.min(Math.abs(x - 40), Math.abs(x - 160))).toBeLessThan(4);
			expect(Math.min(Math.abs(y - 40), Math.abs(y - 160))).toBeLessThan(4);
		}
	});
});

describe("refineQuadEdgesDetailed", () => {
	it("reports high confidence on a clear edge and zero on a featureless field", () => {
		const size = 200;
		const inset: Corners = [
			[60, 60],
			[140, 60],
			[140, 140],
			[60, 140],
		];
		// Clear edge: bright rect on dark field.
		const clear = new Uint8ClampedArray(size * size * 4);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const inside = x >= 40 && x < 160 && y >= 40 && y < 160;
				const i = (y * size + x) * 4;
				clear[i] = clear[i + 1] = clear[i + 2] = inside ? 220 : 30;
				clear[i + 3] = 255;
			}
		const strong = refineQuadEdgesDetailed(
			{ data: clear, width: size, height: size },
			inset,
			{ search: 40 },
		);
		for (const c of strong.confidence) expect(c).toBeGreaterThan(3);

		// Featureless: a flat grey field — no boundary to find anywhere.
		const flat = new Uint8ClampedArray(size * size * 4);
		for (let i = 0; i < size * size; i++) {
			flat[i * 4] = flat[i * 4 + 1] = flat[i * 4 + 2] = 100;
			flat[i * 4 + 3] = 255;
		}
		const weak = refineQuadEdgesDetailed(
			{ data: flat, width: size, height: size },
			inset,
			{ search: 40, minConfidence: 3 },
		);
		for (const c of weak.confidence) expect(c).toBeLessThan(3);
		// With minConfidence, every edge reverts to the picked line.
		for (let i = 0; i < 4; i++) {
			expect(weak.corners[i][0]).toBeCloseTo(inset[i][0], 3);
			expect(weak.corners[i][1]).toBeCloseTo(inset[i][1], 3);
		}
	});
});

describe("offsetQuad", () => {
	it("dilates outward and erodes inward by the given px", () => {
		const quad: Corners = [
			[50, 50],
			[150, 50],
			[150, 150],
			[50, 150],
		];
		const out = offsetQuad(quad, 10); // grow 10px each edge
		expect(out[0][0]).toBeCloseTo(40, 5);
		expect(out[0][1]).toBeCloseTo(40, 5);
		expect(out[2][0]).toBeCloseTo(160, 5);
		expect(out[2][1]).toBeCloseTo(160, 5);
		const shrunk = offsetQuad(quad, -10); // shrink 10px each edge
		expect(shrunk[0][0]).toBeCloseTo(60, 5);
		expect(shrunk[2][0]).toBeCloseTo(140, 5);
	});

	it("applies per-edge deltas independently", () => {
		const quad: Corners = [
			[50, 50],
			[150, 50],
			[150, 150],
			[50, 150],
		];
		// Only the right edge (TR→BR, index 1) erodes inward by 20.
		const out = offsetQuad(quad, [0, -20, 0, 0]);
		expect(out[1][0]).toBeCloseTo(130, 5); // TR pulled left
		expect(out[2][0]).toBeCloseTo(130, 5); // BR pulled left
		expect(out[0][0]).toBeCloseTo(50, 5); // TL untouched
		expect(out[1][1]).toBeCloseTo(50, 5); // top edge untouched
	});
});

describe("midQuad / edgeDistances", () => {
	it("midQuad is the corner-wise midpoint; edgeDistances measure the band per edge", () => {
		const quad: Corners = [
			[60, 60],
			[140, 60],
			[140, 140],
			[60, 140],
		];
		const inner = offsetQuad(quad, -10);
		const outer = offsetQuad(quad, 10);
		const mid = midQuad(inner, outer);
		// For an axis-aligned square, the midpoints land back on the original quad.
		for (let i = 0; i < 4; i++) {
			expect(mid[i][0]).toBeCloseTo(quad[i][0], 5);
			expect(mid[i][1]).toBeCloseTo(quad[i][1], 5);
		}
		// Each edge sits 10 px from either side of the band.
		for (const d of edgeDistances(mid, outer)) expect(d).toBeCloseTo(10, 5);
		for (const d of edgeDistances(mid, inner)) expect(d).toBeCloseTo(10, 5);
	});
});
