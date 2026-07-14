import { describe, expect, it } from "vitest";
import {
	autoTone,
	type Corners,
	detectSleeveCorners,
	homography,
	padToCanvas,
	type RgbaImage,
	reframeFromCorners,
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

	it("returns null for an image too small to detect", () => {
		const img = rectOnBg(30, [40, 40, 40], [200, 200, 200], [4, 4, 26, 26]);
		expect(detectSleeveCorners(img)).toBeNull();
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
