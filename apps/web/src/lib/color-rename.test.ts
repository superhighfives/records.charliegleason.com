import { describe, expect, it } from "vitest";
import { renameColorRefusal } from "#/lib/color-rename";
import { DEFAULT_COLOR_NAME } from "#/lib/default-color";

describe("renameColorRefusal", () => {
	it("refuses a colour that's gone", () => {
		expect(renameColorRefusal(undefined, "Red", false)).toMatch(/no longer/);
	});
	it("refuses renaming the default colour", () => {
		expect(
			renameColorRefusal({ name: DEFAULT_COLOR_NAME }, "Jet", false),
		).toMatch(/can't be renamed/);
	});
	it("refuses a name another colour has", () => {
		expect(renameColorRefusal({ name: "Red" }, "Blue", true)).toMatch(
			/already a color/,
		);
	});
	it("allows a fresh name, and a same-name no-op", () => {
		expect(renameColorRefusal({ name: "Red" }, "Crimson", false)).toBeNull();
		expect(
			renameColorRefusal(
				{ name: DEFAULT_COLOR_NAME },
				DEFAULT_COLOR_NAME,
				true,
			),
		).toBeNull();
	});
});
