import { describe, expect, it } from "vitest";

import { numberToWords } from "#/lib/number-to-words";

describe("numberToWords", () => {
	it("spells out single digits and teens", () => {
		expect(numberToWords(0)).toBe("zero");
		expect(numberToWords(7)).toBe("seven");
		expect(numberToWords(13)).toBe("thirteen");
	});

	it("hyphenates compound tens", () => {
		expect(numberToWords(20)).toBe("twenty");
		expect(numberToWords(21)).toBe("twenty-one");
		expect(numberToWords(99)).toBe("ninety-nine");
	});

	it("joins hundreds with 'and'", () => {
		expect(numberToWords(100)).toBe("one hundred");
		expect(numberToWords(283)).toBe("two hundred and eighty-three");
		expect(numberToWords(105)).toBe("one hundred and five");
	});

	it("handles thousands", () => {
		expect(numberToWords(1000)).toBe("one thousand");
		expect(numberToWords(2005)).toBe("two thousand and five");
		expect(numberToWords(12345)).toBe(
			"twelve thousand three hundred and forty-five",
		);
	});

	it("falls back to the numeral outside the supported range", () => {
		expect(numberToWords(-1)).toBe("-1");
		expect(numberToWords(1.5)).toBe("1.5");
		expect(numberToWords(1_000_000)).toBe("1000000");
	});
});
