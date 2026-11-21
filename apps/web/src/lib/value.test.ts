import { describe, expect, it } from "vitest";

import { isMonthlyRefreshDay, valuationKey } from "./value";

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

describe("isMonthlyRefreshDay", () => {
	it("is true on the 1st in UTC, whatever the local zone", () => {
		expect(isMonthlyRefreshDay(Date.parse("2026-12-01T13:00:00Z"))).toBe(true);
		expect(isMonthlyRefreshDay(Date.parse("2026-11-30T23:59:59Z"))).toBe(false);
		expect(isMonthlyRefreshDay(Date.parse("2026-12-02T00:00:00Z"))).toBe(false);
	});
});
