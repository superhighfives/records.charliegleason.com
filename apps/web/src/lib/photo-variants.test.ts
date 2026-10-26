import { describe, expect, it } from "vitest";

import {
	hasPresizedVariants,
	PRESIZED_WIDTHS,
	presizedKey,
	withPresizedKeys,
} from "./photo-variants";

const MASTER = "professional/8eedd716-8c0b-4fda-bcbd-b3884fc46281.webp";

describe("presizedKey", () => {
	it("suffixes the width before the extension", () => {
		expect(presizedKey(MASTER, 500)).toBe(
			"professional/8eedd716-8c0b-4fda-bcbd-b3884fc46281@500.webp",
		);
	});
});

describe("hasPresizedVariants", () => {
	it("is true only for professional webp masters", () => {
		expect(hasPresizedVariants(MASTER)).toBe(true);
		expect(hasPresizedVariants(presizedKey(MASTER, 500))).toBe(false);
		expect(hasPresizedVariants("alpha/abc.webp")).toBe(false);
		expect(hasPresizedVariants("captures/abc.webp")).toBe(false);
		expect(hasPresizedVariants("professional/abc.png")).toBe(false);
	});
});

describe("withPresizedKeys", () => {
	it("lists the master plus one copy per width", () => {
		expect(withPresizedKeys(MASTER)).toEqual([
			MASTER,
			...PRESIZED_WIDTHS.map((w) => presizedKey(MASTER, w)),
		]);
	});

	it("leaves other keys alone", () => {
		expect(withPresizedKeys("alpha/abc.webp")).toEqual(["alpha/abc.webp"]);
	});
});
