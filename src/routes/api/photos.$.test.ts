import { describe, expect, it } from "vitest";
import { parseFormat } from "./photos.$";

describe("parseFormat", () => {
	it("defaults to webp for missing or unrecognized values", () => {
		expect(parseFormat(null)).toBe("webp");
		expect(parseFormat("png")).toBe("webp");
	});

	it("selects jpeg when explicitly requested", () => {
		expect(parseFormat("jpeg")).toBe("jpeg");
	});
});
