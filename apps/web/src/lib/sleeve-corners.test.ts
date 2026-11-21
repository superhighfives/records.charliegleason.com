import { describe, expect, it } from "vitest";
import {
	cropBoxFor,
	cropFromEdge,
	DEFAULT_CORNERS,
	DEFAULT_CROP,
	edgeFromCrop,
	isCropValid,
	type NormalizedCorners,
	parseCrop,
	serializeCrop,
	toCropCorners,
	trimFor,
} from "./sleeve-corners";

const square: NormalizedCorners = [
	[0.2, 0.2],
	[0.8, 0.2],
	[0.8, 0.8],
	[0.2, 0.8],
];

describe("parseCrop", () => {
	it("reads a stored band as exactly its inner quad, the crop it warped from", () => {
		const stored = JSON.stringify({
			inner: [
				[0.21, 0.22],
				[0.79, 0.2],
				[0.8, 0.78],
				[0.2, 0.8],
			],
			outer: [
				[0.19, 0.2],
				[0.81, 0.18],
				[0.82, 0.8],
				[0.18, 0.82],
			],
		});
		expect(parseCrop(stored)).toEqual([
			[0.21, 0.22],
			[0.79, 0.2],
			[0.8, 0.78],
			[0.2, 0.8],
		]);
	});

	it("round-trips a bare quad", () => {
		expect(parseCrop(serializeCrop(square))).toEqual(square);
	});

	it("falls back to the default crop on junk or nothing", () => {
		expect(parseCrop(null)).toEqual(DEFAULT_CROP);
		expect(parseCrop("not json")).toEqual(DEFAULT_CROP);
		expect(parseCrop(JSON.stringify([[2, 0]]))).toEqual(DEFAULT_CROP);
	});
});

describe("DEFAULT_CROP", () => {
	it("is the frame inset by 1.2%, matching the old default band's inner quad", () => {
		const expected = [
			[0.012, 0.012],
			[0.988, 0.012],
			[0.988, 0.988],
			[0.012, 0.988],
		];
		DEFAULT_CROP.forEach(([x, y], i) => {
			expect(x).toBeCloseTo(expected[i][0], 6);
			expect(y).toBeCloseTo(expected[i][1], 6);
		});
	});
});

describe("cropFromEdge / edgeFromCrop", () => {
	it("insets the crop inside the edge, and back out again", () => {
		const crop = cropFromEdge(square);
		expect(crop[0][0]).toBeGreaterThan(square[0][0]);
		expect(crop[2][0]).toBeLessThan(square[2][0]);
		edgeFromCrop(crop).forEach(([x, y], i) => {
			expect(x).toBeCloseTo(square[i][0], 3);
			expect(y).toBeCloseTo(square[i][1], 3);
		});
	});
});

describe("isCropValid", () => {
	it("accepts a convex quad and rejects one with crossed corners", () => {
		expect(isCropValid(square)).toBe(true);
		expect(isCropValid(DEFAULT_CORNERS)).toBe(true);
		const crossed: NormalizedCorners = [
			square[0],
			square[2],
			square[1],
			square[3],
		];
		expect(isCropValid(crossed)).toBe(false);
	});
});

describe("cropBoxFor / toCropCorners", () => {
	const quad: NormalizedCorners = [
		[0.25, 0.2],
		[0.75, 0.2],
		[0.75, 0.8],
		[0.25, 0.8],
	];

	it("pads the quad's box by the margin and clamps it to the image", () => {
		expect(cropBoxFor(quad, 1000, 1000, 0.05)).toEqual({
			left: 200,
			top: 150,
			width: 600,
			height: 700,
		});
		expect(cropBoxFor(quad, 1000, 1000, 0.5)).toEqual({
			left: 0,
			top: 0,
			width: 1000,
			height: 1000,
		});
	});

	it("turns the box into the pixels to cut off each side", () => {
		const box = cropBoxFor(quad, 1000, 800, 0);
		expect(box).toEqual({ left: 250, top: 160, width: 500, height: 480 });
		expect(trimFor(box, 1000, 800)).toEqual({
			left: 250,
			top: 160,
			right: 250,
			bottom: 160,
		});
	});

	it("maps the quad into the crop, so the warp sees the same sleeve", () => {
		const box = cropBoxFor(quad, 1000, 1000, 0);
		expect(toCropCorners(quad, box, 1000, 1000)).toEqual([
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		]);
	});
});
