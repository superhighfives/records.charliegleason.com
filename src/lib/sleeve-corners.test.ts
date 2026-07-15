import { describe, expect, it } from "vitest";
import {
	bandFromQuad,
	DEFAULT_BAND,
	DEFAULT_CORNERS,
	isBandValid,
	type NormalizedCorners,
	parseCornerBand,
	parseCorners,
	serializeCornerBand,
} from "./sleeve-corners";

const PICK: NormalizedCorners = [
	[0.1, 0.1],
	[0.9, 0.12],
	[0.88, 0.9],
	[0.12, 0.88],
];

describe("bandFromQuad", () => {
	it("brackets the quad: inner strictly inside it, outer strictly outside", () => {
		const band = bandFromQuad(PICK);
		for (let i = 0; i < 4; i++) {
			const [px, py] = PICK[i];
			const [ix, iy] = band.inner[i];
			const [ox, oy] = band.outer[i];
			// Each inner corner pulls toward the centre, each outer corner away from it.
			const cx = 0.5;
			const cy = 0.5;
			expect(Math.hypot(ix - cx, iy - cy)).toBeLessThan(
				Math.hypot(px - cx, py - cy),
			);
			expect(Math.hypot(ox - cx, oy - cy)).toBeGreaterThanOrEqual(
				Math.hypot(px - cx, py - cy) - 1e-9,
			);
		}
		expect(isBandValid(band)).toBe(true);
	});

	it("clamps the outer quad to the frame at the edges (full-frame default)", () => {
		const band = bandFromQuad(DEFAULT_CORNERS);
		for (const [x, y] of band.outer) {
			expect(x === 0 || x === 1).toBe(true);
			expect(y === 0 || y === 1).toBe(true);
		}
		expect(isBandValid(band)).toBe(true);
	});
});

describe("parseCornerBand", () => {
	it("round-trips the {inner, outer} shape", () => {
		const band = bandFromQuad(PICK);
		expect(parseCornerBand(serializeCornerBand(band))).toEqual(
			JSON.parse(JSON.stringify(parseCornerBand(serializeCornerBand(band)))),
		);
		const parsed = parseCornerBand(serializeCornerBand(band));
		for (let i = 0; i < 4; i++) {
			expect(parsed.inner[i][0]).toBeCloseTo(band.inner[i][0], 3);
			expect(parsed.outer[i][1]).toBeCloseTo(band.outer[i][1], 3);
		}
	});

	it("synthesises a band from a legacy single-quad row", () => {
		const legacy = JSON.stringify(PICK);
		const band = parseCornerBand(legacy);
		expect(isBandValid(band)).toBe(true);
		// The legacy pick sat on the true edge — it must lie inside the band.
		const synth = bandFromQuad(PICK);
		expect(band).toEqual(synth);
	});

	it("falls back to the full-frame default on junk", () => {
		expect(parseCornerBand(null)).toEqual(DEFAULT_BAND);
		expect(parseCornerBand("not json")).toEqual(DEFAULT_BAND);
		expect(parseCornerBand('{"inner": 3}')).toEqual(DEFAULT_BAND);
		expect(parseCornerBand("[[2,0],[1,0],[1,1],[0,1]]")).toEqual(DEFAULT_BAND);
	});
});

describe("parseCorners (legacy single-quad reader)", () => {
	it("reads the outer quad out of a stored band", () => {
		const band = bandFromQuad(PICK);
		const quad = parseCorners(serializeCornerBand(band));
		for (let i = 0; i < 4; i++) {
			expect(quad[i][0]).toBeCloseTo(band.outer[i][0], 3);
			expect(quad[i][1]).toBeCloseTo(band.outer[i][1], 3);
		}
	});
});

describe("isBandValid", () => {
	it("rejects an inner corner dragged outside the outer quad", () => {
		const band = bandFromQuad(PICK);
		const crossed = {
			...band,
			inner: band.inner.map((c, i) =>
				i === 0 ? ([0, 0] as [number, number]) : c,
			) as NormalizedCorners,
		};
		expect(isBandValid(crossed)).toBe(false);
	});
});
