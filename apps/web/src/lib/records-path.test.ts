import { describe, expect, it } from "vitest";

import {
	parseRecordIdParam,
	recordIdParam,
	recordPath,
	slugifyTitle,
} from "#/lib/records-path";

describe("slugifyTitle", () => {
	it("lowercases and dash-joins", () => {
		expect(slugifyTitle("The Moon & Antarctica")).toBe(
			"the-moon-and-antarctica",
		);
	});
	it("strips diacritics", () => {
		expect(slugifyTitle("Björk — Homogénic")).toBe("bjork-homogenic");
	});
	it("trims leading/trailing separators and punctuation", () => {
		expect(slugifyTitle("  ...Baby One More Time!  ")).toBe(
			"baby-one-more-time",
		);
	});
	it("is empty for a null or symbol-only title", () => {
		expect(slugifyTitle(null)).toBe("");
		expect(slugifyTitle("!!!")).toBe("");
	});
});

describe("recordIdParam / recordPath", () => {
	it("prefixes the id and appends the slug", () => {
		const r = { id: 293, title: "The Moon & Antarctica" };
		expect(recordIdParam(r)).toBe("293-the-moon-and-antarctica");
		expect(recordPath(r)).toBe("/records/293-the-moon-and-antarctica");
	});
	it("falls back to the bare id when the title slugifies to nothing", () => {
		expect(recordIdParam({ id: 7, title: "!!!" })).toBe("7");
		expect(recordPath({ id: 7, title: null })).toBe("/records/7");
	});
});

describe("parseRecordIdParam", () => {
	it("pulls the leading id regardless of the slug", () => {
		expect(parseRecordIdParam("293-the-moon-and-antarctica")).toBe(293);
		expect(parseRecordIdParam("293")).toBe(293);
		expect(parseRecordIdParam("293-anything-here")).toBe(293);
	});
	it("rejects params that don't start with a positive integer", () => {
		expect(parseRecordIdParam("abc")).toBeNull();
		expect(parseRecordIdParam("-5")).toBeNull();
		expect(parseRecordIdParam("0-x")).toBeNull();
	});
});
