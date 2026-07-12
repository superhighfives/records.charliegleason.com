import { describe, expect, it } from "vitest";
import {
	autoTone,
	bboxFromMask,
	type Corners,
	cornersFromMask,
	homography,
	isQuadTrustworthy,
	type RgbaImage,
	reframeSquare,
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

/** Paste a sleeve into a bigger canvas under a known perspective, with an alpha mask. */
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
				data[i + 3] = 255; // alpha marks the sleeve
			} else {
				data[i] = 120;
				data[i + 1] = 90;
				data[i + 2] = 60;
				data[i + 3] = 0; // background is transparent in the cutout
			}
		}
	return { data, width: canvas, height: canvas };
}

describe("cornersFromMask + warpToSquare", () => {
	it("detects a rotated/keystoned quad's corners exactly", () => {
		const corners: Corners = [
			[140, 90],
			[770, 160],
			[810, 740],
			[95, 690],
		];
		const cap = synthCapture(checkerboard(512), 900, corners);
		const detected = cornersFromMask(cap);
		expect(detected).toEqual(corners);
		expect(isQuadTrustworthy(detected, 900, 900)).toBe(true);
	});

	it("recovers the original sleeve by un-warping the detected quad", () => {
		const size = 512;
		const corners: Corners = [
			[140, 90],
			[770, 160],
			[810, 740],
			[95, 690],
		];
		const sleeve = checkerboard(size);
		const cap = synthCapture(sleeve, 900, corners);
		const detected = cornersFromMask(cap);
		if (!detected) throw new Error("no corners");
		const recovered = warpToSquare(cap, detected, size);

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

describe("isQuadTrustworthy", () => {
	it("rejects a badly keystoned quad", () => {
		const bad: Corners = [
			[100, 100],
			[800, 100],
			[500, 700],
			[400, 700],
		];
		expect(isQuadTrustworthy(bad, 900, 900)).toBe(false);
	});

	it("rejects a tiny quad", () => {
		const tiny: Corners = [
			[10, 10],
			[40, 10],
			[40, 40],
			[10, 40],
		];
		expect(isQuadTrustworthy(tiny, 900, 900)).toBe(false);
	});

	it("rejects null", () => {
		expect(isQuadTrustworthy(null, 900, 900)).toBe(false);
	});
});

describe("bboxFromMask", () => {
	it("returns the axis-aligned bounding rectangle", () => {
		const cap = synthCapture(checkerboard(256), 500, [
			[100, 120],
			[380, 120],
			[380, 400],
			[100, 400],
		]);
		expect(bboxFromMask(cap)).toEqual([
			[100, 120],
			[380, 120],
			[380, 400],
			[100, 400],
		]);
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

describe("reframeSquare", () => {
	it("perspective-warps a trustworthy quad and pads to the canvas", () => {
		const cap = synthCapture(checkerboard(512), 900, [
			[140, 90],
			[770, 160],
			[810, 740],
			[95, 690],
		]);
		const { image, perspective } = reframeSquare(cap, {
			canvasSize: 200,
			contentSize: 180,
		});
		expect(perspective).toBe(true);
		expect(image.width).toBe(200);
		expect(image.height).toBe(200);
		// centre is opaque sleeve, extreme corner is transparent margin
		const centre = (100 * 200 + 100) * 4;
		expect(image.data[centre + 3]).toBeGreaterThan(200);
		expect(image.data[3]).toBe(0);
	});

	it("falls back to a bbox crop when the quad is untrustworthy", () => {
		// a thin sliver mask → not square → untrustworthy → bbox path
		const size = 400;
		const data = new Uint8ClampedArray(size * size * 4);
		for (let y = 150; y < 250; y++)
			for (let x = 20; x < 380; x++) {
				const i = (y * size + x) * 4;
				data[i] = 200;
				data[i + 3] = 255;
			}
		const { perspective } = reframeSquare(
			{ data, width: size, height: size },
			{ canvasSize: 200, contentSize: 180 },
		);
		expect(perspective).toBe(false);
	});
});
