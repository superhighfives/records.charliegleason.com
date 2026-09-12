import { describe, expect, it } from "vitest";
import type { PublicRecord } from "#/lib/records";
import { toLiteRecord } from "./lite-record";

function record(overrides: Partial<PublicRecord>): PublicRecord {
	return {
		id: 1,
		artist: "Artist",
		title: "Title",
		coverImageKey: null,
		professionalImageKey: null,
		...overrides,
	} as PublicRecord;
}

describe("toLiteRecord", () => {
	it("prefers the professional image over the cover", () => {
		const result = toLiteRecord(
			record({
				coverImageKey: "covers/a.jpg",
				professionalImageKey: "pro/a.jpg",
			}),
		);
		expect(result?.coverKey).toBe("pro/a.jpg");
	});

	it("falls back to the cover image when there's no professional image", () => {
		const result = toLiteRecord(record({ coverImageKey: "covers/a.jpg" }));
		expect(result?.coverKey).toBe("covers/a.jpg");
	});

	it("drops records with neither key", () => {
		expect(toLiteRecord(record({}))).toBeNull();
	});
});
