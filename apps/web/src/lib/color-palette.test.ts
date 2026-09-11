import { describe, expect, it } from "vitest";

import { extractPalette, parseColorPalette } from "#/lib/color-palette";
import type { RgbaImage } from "#/lib/photo-processing";

/** Build a solid-color RGBA image. */
function solid(r: number, g: number, b: number, size = 8, a = 255): RgbaImage {
	const data = new Uint8ClampedArray(size * size * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = r;
		data[i + 1] = g;
		data[i + 2] = b;
		data[i + 3] = a;
	}
	return { data, width: size, height: size };
}

/** Build a two-color image split left/right. */
function split(
	a: [number, number, number],
	b: [number, number, number],
	size = 8,
): RgbaImage {
	const data = new Uint8ClampedArray(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const [r, g, bl] = x < size / 2 ? a : b;
			const i = (y * size + x) * 4;
			data[i] = r;
			data[i + 1] = g;
			data[i + 2] = bl;
			data[i + 3] = 255;
		}
	}
	return { data, width: size, height: size };
}

describe("extractPalette", () => {
	it("returns a single color for a flat texture", () => {
		const palette = extractPalette(solid(0x3a, 0x5f, 0x8a));
		expect(palette).not.toBeNull();
		expect(palette?.dominant).toBe("#3a5f8a");
		expect(palette?.colors).toEqual(["#3a5f8a"]);
	});

	it("orders gradient endpoints light → dark", () => {
		// A light and a dark blue in equal measure.
		const palette = extractPalette(
			split([0x9a, 0xc0, 0xe6], [0x14, 0x28, 0x40]),
		);
		expect(palette?.colors).toHaveLength(2);
		const [light, dark] = palette?.colors ?? [];
		const lum = (hex: string) => {
			const n = Number.parseInt(hex.slice(1), 16);
			return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
		};
		expect(lum(light)).toBeGreaterThan(lum(dark));
	});

	it("prefers a saturated hue over a larger gray patch for dominant", () => {
		// Three-quarters gray, one-quarter vivid red — dominant should be the red.
		const size = 8;
		const data = new Uint8ClampedArray(size * size * 4);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const red = x >= size * 0.75;
				const i = (y * size + x) * 4;
				data[i] = red ? 220 : 128;
				data[i + 1] = red ? 20 : 128;
				data[i + 2] = red ? 20 : 128;
				data[i + 3] = 255;
			}
		}
		const palette = extractPalette({ data, width: size, height: size });
		expect(palette?.dominant).toBe("#dc1414");
	});

	it("skips transparent pixels and returns null when fully transparent", () => {
		expect(extractPalette(solid(10, 20, 30, 8, 0))).toBeNull();
	});

	it("returns null for an empty image", () => {
		expect(
			extractPalette({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
		).toBeNull();
	});
});

describe("parseColorPalette", () => {
	it("round-trips a valid palette", () => {
		expect(
			parseColorPalette(
				'{"dominant":"#3a5f8a","colors":["#9ac0e6","#142840"]}',
			),
		).toEqual({ dominant: "#3a5f8a", colors: ["#9ac0e6", "#142840"] });
	});

	it("drops malformed hex entries but keeps valid ones", () => {
		expect(
			parseColorPalette('{"dominant":"#3a5f8a","colors":["#9ac0e6","nope"]}'),
		).toEqual({ dominant: "#3a5f8a", colors: ["#9ac0e6"] });
	});

	it("returns null for missing, malformed, or empty input", () => {
		expect(parseColorPalette(null)).toBeNull();
		expect(parseColorPalette("")).toBeNull();
		expect(parseColorPalette("not json")).toBeNull();
		expect(parseColorPalette('{"dominant":"#3a5f8a"}')).toBeNull();
		expect(
			parseColorPalette('{"dominant":"blue","colors":["#9ac0e6"]}'),
		).toBeNull();
		expect(parseColorPalette('{"dominant":"#3a5f8a","colors":[]}')).toBeNull();
	});
});
