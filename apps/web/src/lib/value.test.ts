import { describe, expect, it } from "vitest";

import { valuationKey } from "./value";

describe("valuationKey", () => {
	it("prices from the pinned pressing over the album", () => {
		expect(valuationKey({ masterId: "1", discogsId: "2" })).toBe("release:2");
	});

	it("falls back to the album, then to nothing", () => {
		expect(valuationKey({ masterId: "1", discogsId: null })).toBe("master:1");
		expect(valuationKey({ masterId: null, discogsId: null })).toBeNull();
	});

	it("changes when the album changes under no pinned pressing", () => {
		expect(valuationKey({ masterId: "1", discogsId: null })).not.toBe(
			valuationKey({ masterId: "3", discogsId: null }),
		);
	});
});
