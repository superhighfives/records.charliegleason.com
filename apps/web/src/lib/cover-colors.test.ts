import { describe, expect, it } from "vitest";

import { keyColors } from "#/lib/cover-colors";

/** RGBA pixels: `count` of each colour, in order. */
function pixels(...runs: [number, number, number, number][]) {
	const out: number[] = [];
	for (const [r, g, b, count] of runs) {
		for (let i = 0; i < count; i++) out.push(r, g, b, 255);
	}
	return new Uint8ClampedArray(out);
}

describe("keyColors", () => {
	it("returns one colour for a flat image", () => {
		expect(keyColors(pixels([200, 40, 40, 50]))).toEqual(["#c82828"]);
	});

	it("favours a saturated colour over a slightly more common grey", () => {
		const colors = keyColors(pixels([128, 128, 128, 60], [220, 30, 30, 40]));
		expect(colors[0]).toBe("#dc1e1e");
		expect(colors).toContain("#808080");
	});

	it("skips colours too close to one already picked", () => {
		const colors = keyColors(
			pixels([200, 40, 40, 50], [210, 45, 45, 40], [30, 60, 200, 30]),
		);
		expect(colors).toHaveLength(2);
	});

	it("ignores transparent pixels and caps the count", () => {
		const data = pixels(
			[255, 0, 0, 10],
			[0, 255, 0, 10],
			[0, 0, 255, 10],
			[255, 255, 0, 10],
			[0, 255, 255, 10],
		);
		expect(keyColors(data, 3)).toHaveLength(3);
		expect(keyColors(new Uint8ClampedArray([255, 0, 0, 0]))).toEqual([]);
	});
});
