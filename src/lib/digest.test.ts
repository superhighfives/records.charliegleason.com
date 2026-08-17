import { describe, expect, it } from "vitest";

import { normalize } from "./digest";

describe("normalize", () => {
	it("strips a trailing parenthesized edition qualifier", () => {
		expect(normalize("Alligator Bites Never Heal (Extended)")).toBe(
			"alligator bites never heal",
		);
		expect(normalize("Album (Deluxe)")).toBe("album");
	});

	it("strips a trailing bracketed edition qualifier", () => {
		expect(normalize("Album [Deluxe]")).toBe("album");
	});

	it("strips a trailing dash-qualified edition", () => {
		expect(normalize("Title - Remastered")).toBe("title");
		expect(normalize("Title - Deluxe Edition")).toBe("title");
	});

	it("leaves a standalone album title alone", () => {
		expect(normalize("Clean")).toBe("clean");
		expect(normalize("Radio")).toBe("radio");
		expect(normalize("Special")).toBe("special");
		expect(normalize("Bonus Track")).toBe("bonus track");
	});

	it("does not strip mismatched bracket pairs", () => {
		expect(normalize("Title (Deluxe]")).toBe("title deluxe");
		expect(normalize("Title [Deluxe)")).toBe("title deluxe");
	});
});
