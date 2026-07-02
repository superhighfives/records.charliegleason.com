import { describe, expect, it } from "vitest";

import { parseSizeAndType } from "./discogs";

describe("parseSizeAndType", () => {
	it("reads size and type from a descriptions array", () => {
		expect(parseSizeAndType(['12"', "33 ⅓ RPM", "LP", "Album"])).toEqual({
			size: '12"',
			type: "LP",
		});
	});

	it("accepts a joined format string", () => {
		expect(parseSizeAndType('Vinyl, 7", 45 RPM, Single')).toEqual({
			size: '7"',
			type: "Single",
		});
	});

	it("folds Album to LP when nothing more specific is present", () => {
		// A 12" album is often tagged "Album" with no "LP".
		expect(parseSizeAndType(['12"', "33 ⅓ RPM", "Album"])).toEqual({
			size: '12"',
			type: "LP",
		});
	});

	it('defaults a size-less LP to 12" (Discogs omits it for standard LPs)', () => {
		// e.g. Radiohead — In Rainbows: descriptions are ["LP", "Album", "Reissue"].
		expect(parseSizeAndType(["LP", "Album", "Reissue"])).toEqual({
			size: '12"',
			type: "LP",
		});
	});

	it("prefers EP and Single over LP/Album", () => {
		expect(parseSizeAndType('12", EP').type).toBe("EP");
		expect(parseSizeAndType('12", Maxi-Single, 45 RPM').type).toBe("Single");
	});

	it('handles 10" pressings', () => {
		expect(parseSizeAndType(['10"', "EP"])).toEqual({
			size: '10"',
			type: "EP",
		});
	});

	it("returns nulls for empty or unrecognised input", () => {
		expect(parseSizeAndType(null)).toEqual({ size: null, type: null });
		expect(parseSizeAndType("")).toEqual({ size: null, type: null });
		expect(parseSizeAndType("Vinyl")).toEqual({ size: null, type: null });
	});
});
