import { describe, expect, it } from "vitest";
import {
	bandFromQuad,
	bandInvalidReason,
	DEFAULT_BAND,
	DEFAULT_CORNERS,
	isBandValid,
	MIN_BAND_FRAC,
	minBandGapFrac,
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
		expect(bandInvalidReason(crossed)).toBe("crossed");
	});
});

// A concentric square band; the inner offset from the outer sets the gap exactly.
const OUTER_SQ: NormalizedCorners = [
	[0.1, 0.1],
	[0.9, 0.1],
	[0.9, 0.9],
	[0.1, 0.9],
];
const squareBand = (
	inset: number,
): { inner: NormalizedCorners; outer: NormalizedCorners } => ({
	outer: OUTER_SQ,
	inner: [
		[0.1 + inset, 0.1 + inset],
		[0.9 - inset, 0.1 + inset],
		[0.9 - inset, 0.9 - inset],
		[0.1 + inset, 0.9 - inset],
	],
});

describe("minBandGapFrac", () => {
	it("measures the narrowest inner→outer gap as a fraction of the mean side", () => {
		// Outer square side 0.8; inner inset 0.02 → gap 0.02, fraction 0.02/0.8 = 0.025.
		expect(minBandGapFrac(squareBand(0.02))).toBeCloseTo(0.025, 6);
	});
});

describe("isBandValid / bandInvalidReason — band-width floor", () => {
	it("accepts a comfortably wide band", () => {
		expect(minBandGapFrac(squareBand(0.02))).toBeGreaterThan(MIN_BAND_FRAC);
		expect(bandInvalidReason(squareBand(0.02))).toBeNull();
	});

	it("rejects a too-thin band even though its inner sits inside the outer", () => {
		const thin = squareBand(0.002); // gap 0.002/0.8 = 0.0025 ≪ floor
		expect(minBandGapFrac(thin)).toBeLessThan(MIN_BAND_FRAC);
		expect(isBandValid(thin)).toBe(false);
		expect(bandInvalidReason(thin)).toBe("narrow");
	});

	it("keeps the floor above the real clamp-overlap risk (~0.0105) and below the default's gap", () => {
		expect(MIN_BAND_FRAC).toBeGreaterThan(0.0105);
		// The full-frame default (and thus every wider pick) clears the floor by construction.
		expect(minBandGapFrac(DEFAULT_BAND)).toBeGreaterThanOrEqual(MIN_BAND_FRAC);
		expect(isBandValid(DEFAULT_BAND)).toBe(true);
	});
});

describe("bandFromQuad — synthesis floor", () => {
	it("keeps a frame-hugging pick valid despite the outer offset clamping", () => {
		// Left edge flush to the frame: the outward offset can't grow past x=0, which would
		// otherwise pinch the band on that side. The synthesis floor widens the inner instead.
		const flush: NormalizedCorners = [
			[0, 0.1],
			[0.9, 0.1],
			[0.9, 0.9],
			[0, 0.9],
		];
		const band = bandFromQuad(flush);
		expect(isBandValid(band)).toBe(true);
		expect(minBandGapFrac(band)).toBeGreaterThanOrEqual(MIN_BAND_FRAC);
	});
});
