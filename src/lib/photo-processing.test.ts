import { describe, expect, it } from "vitest";
import {
	autoTone,
	bleedEdgeColor,
	boxBlur1,
	buildTrimap,
	type Corners,
	composeMatte,
	composeMatteWarped,
	deskewToLevel,
	detectSleeveCorners,
	homography,
	keepLargestComponent,
	matteFromCorners,
	offsetQuad,
	padToCanvas,
	type RgbaImage,
	rasterizePolygon,
	refineQuadEdges,
	reframeFromCorners,
	shadowFromAlpha,
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

describe("deskewToLevel", () => {
	it("removes the capture's tilt without squaring (recovers side lengths, levels the top edge)", () => {
		// A 200×100 rectangle rotated by 20° — deskew should undo the rotation, so its
		// bounding box is back to 200×100 and the (former) top edge is horizontal again.
		const t = (20 * Math.PI) / 180;
		const cos = Math.cos(t);
		const sin = Math.sin(t);
		const rot = ([x, y]: [number, number]): [number, number] => [
			x * cos - y * sin,
			x * sin + y * cos,
		];
		const corners: Corners = [
			rot([0, 0]),
			rot([200, 0]),
			rot([200, 100]),
			rot([0, 100]),
		];
		const { dst, width, height } = deskewToLevel(corners);
		expect(width).toBeCloseTo(200, 0);
		expect(height).toBeCloseTo(100, 0);
		// The top edge (dst[0]→dst[1]) is level again.
		expect(Math.abs(dst[0][1] - dst[1][1])).toBeLessThan(1);
	});
});

describe("rasterizePolygon", () => {
	it("fills the interior of a polygon and leaves the outside empty", () => {
		const mask = rasterizePolygon(
			[
				[10, 10],
				[40, 10],
				[40, 40],
				[10, 40],
			],
			50,
			50,
		);
		expect(mask[25 * 50 + 25]).toBe(255); // inside
		expect(mask[2 * 50 + 2]).toBe(0); // outside
		expect(mask[25 * 50 + 45]).toBe(0); // outside, to the right
	});
});

describe("boxBlur1", () => {
	it("spreads a single bright column into its neighbours", () => {
		const w = 21;
		const h = 3;
		const src = new Uint8ClampedArray(w * h);
		for (let y = 0; y < h; y++) src[y * w + 10] = 255; // one bright column
		const out = boxBlur1(src, w, h, 3, 1);
		expect(out[1 * w + 10]).toBeLessThan(255); // centre spread out (dimmer)
		expect(out[1 * w + 8]).toBeGreaterThan(0); // neighbour picked up light
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
});

describe("bleedEdgeColor", () => {
	it("floods opaque colour outward without touching alpha", () => {
		// A single opaque red pixel in the centre of a transparent field; after a 1px
		// bleed, its 4-neighbours take its RGB but stay transparent.
		const s = 5;
		const data = new Uint8ClampedArray(s * s * 4); // all transparent
		const c = (2 * s + 2) * 4; // centre pixel
		data[c] = 200;
		data[c + 1] = 30;
		data[c + 2] = 40;
		data[c + 3] = 255;
		bleedEdgeColor({ data, width: s, height: s }, 1);
		const right = (2 * s + 3) * 4;
		expect(data[right]).toBe(200); // colour bled in
		expect(data[right + 1]).toBe(30);
		expect(data[right + 3]).toBe(0); // but still transparent
		// A pixel two steps away is untouched by a 1px bleed.
		const far = (2 * s + 4) * 4;
		expect(data[far]).toBe(0);
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
});

describe("buildTrimap", () => {
	it("locks foreground/background and leaves a band unknown", () => {
		const size = 200;
		const quad: Corners = [
			[60, 60],
			[140, 60],
			[140, 140],
			[60, 140],
		];
		const trimap = buildTrimap(quad, size, size, { erode: 15, dilate: 15 });
		// Deep inside the eroded quad → definite foreground.
		expect(trimap[100 * size + 100]).toBe(255);
		// Well outside the dilated quad → definite background.
		expect(trimap[10 * size + 10]).toBe(0);
		// On the picked edge, within the ±15 band → unknown.
		expect(trimap[100 * size + 60]).toBe(128);
	});
});

describe("keepLargestComponent", () => {
	it("keeps the biggest blob and drops disconnected strays", () => {
		const w = 20;
		const h = 20;
		const mask = new Uint8ClampedArray(w * h);
		// A big 8×8 block (the "cover") and a stray 2×2 speck in the corner.
		for (let y = 2; y < 10; y++)
			for (let x = 2; x < 10; x++) mask[y * w + x] = 255;
		for (let y = 16; y < 18; y++)
			for (let x = 16; x < 18; x++) mask[y * w + x] = 255;
		const out = keepLargestComponent(mask, w, h);
		expect(out[5 * w + 5]).toBe(255); // inside the big blob — kept
		expect(out[17 * w + 17]).toBe(0); // the stray speck — dropped
	});
});

describe("shadowFromAlpha", () => {
	it("casts a blurred, offset shadow beyond the silhouette", () => {
		// A small opaque square in the top-left of a transparent field.
		const size = 40;
		const data = new Uint8ClampedArray(size * size * 4);
		for (let y = 5; y < 15; y++)
			for (let x = 5; x < 15; x++) {
				const i = (y * size + x) * 4;
				data[i] = 200;
				data[i + 3] = 255;
			}
		const shadow = shadowFromAlpha(
			{ data, width: size, height: size },
			{ blur: 3, offsetX: 4, offsetY: 4, opacity: 0.5 },
		);
		// A pixel just past the square's lower-right (where the offset shadow lands) is
		// tinted, even though the source there was fully transparent.
		expect(shadow.data[(17 * size + 17) * 4 + 3]).toBeGreaterThan(0);
	});
});

describe("matteFromCorners", () => {
	it("floats a toned, shadowed cutout on a transparent margin", () => {
		// A bright sleeve on dark wood, under a slight perspective — the deterministic
		// silhouette should cut it out, centre it, and leave a transparent margin.
		const corners: Corners = [
			[150, 110],
			[760, 150],
			[800, 720],
			[110, 700],
		];
		const cap = synthCapture(checkerboard(512), 900, corners);
		const opts = {
			canvasSize: 200,
			contentSize: 170,
			shadow: { blur: 6, offsetX: 4, offsetY: 6, opacity: 0.35 },
		} as const;
		const { cutout, shadow } = matteFromCorners(cap, corners, opts);

		expect(cutout.width).toBe(200);
		expect(cutout.height).toBe(200);
		// Centre is opaque sleeve; the extreme corner is transparent margin.
		expect(cutout.data[(100 * 200 + 100) * 4 + 3]).toBeGreaterThan(200);
		expect(cutout.data[3]).toBe(0);
		// The shadow variant differs from the pure cutout (it gained shadow pixels).
		expect(shadow.data).not.toEqual(cutout.data);
	});
});

describe("warpMatteToSquare", () => {
	it("straightens a tilted cut sleeve to an upright, centred rectangle", () => {
		// A tilted quad cut out of opaque content (transparent outside it). Warping should
		// straighten it to a centred upright rectangle of ~contentSize.
		const cw = 200;
		const content: RgbaImage = {
			data: new Uint8ClampedArray(cw * cw * 4).fill(255),
			width: cw,
			height: cw,
		};
		const quad: Corners = [
			[50, 40],
			[150, 55],
			[160, 150],
			[45, 140],
		];
		const mask = rasterizePolygon(quad, cw, cw);
		const { cutout } = composeMatteWarped(content, mask, quad, {
			canvasSize: 200,
			contentSize: 160,
			feather: 0,
			tone: false,
		});
		// Centre is opaque sleeve; the extreme corner is transparent margin.
		expect(cutout.data[(100 * 200 + 100) * 4 + 3]).toBe(255);
		expect(cutout.data[3]).toBe(0);
		// The sleeve is centred: symmetric opaque span across the middle row.
		const row = 100;
		let left = 0;
		while (left < 200 && cutout.data[(row * 200 + left) * 4 + 3] < 128) left++;
		let right = 199;
		while (right > 0 && cutout.data[(row * 200 + right) * 4 + 3] < 128) right--;
		expect(Math.abs(left - (200 - 1 - right))).toBeLessThan(6);
	});
});

describe("composeMatte", () => {
	it("cuts content to the mask and centres it with a margin", () => {
		// Solid opaque content, fully-inside mask → after padding, the centre is opaque
		// and the outer margin (beyond contentSize) is transparent.
		const cw = 80;
		const content: RgbaImage = {
			data: new Uint8ClampedArray(cw * cw * 4).fill(255),
			width: cw,
			height: cw,
		};
		const mask = new Uint8ClampedArray(cw * cw).fill(255);
		const { cutout } = composeMatte(content, mask, {
			canvasSize: 200,
			contentSize: 80,
			tone: false,
		});
		expect(cutout.data[(100 * 200 + 100) * 4 + 3]).toBe(255); // centre opaque
		expect(cutout.data[3]).toBe(0); // top-left corner is margin
	});
});
