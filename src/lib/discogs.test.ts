import { describe, expect, it } from "vitest";

import { buildSearchUrl, parseReleaseId, parseSizeAndType } from "./discogs";

describe("parseReleaseId", () => {
	it("pulls the id from a full release URL with a slug", () => {
		expect(
			parseReleaseId(
				"https://www.discogs.com/release/30268103-Private-Life-Private-Life",
			),
		).toBe("30268103");
	});

	it("accepts bare /release/<id> and plural /releases/<id> paths", () => {
		expect(parseReleaseId("/release/30268103")).toBe("30268103");
		expect(parseReleaseId("/releases/30268103")).toBe("30268103");
	});

	it("accepts a bare numeric id, trimming whitespace", () => {
		expect(parseReleaseId("  30268103  ")).toBe("30268103");
	});

	it("returns null for non-release URLs and empty input", () => {
		expect(parseReleaseId("https://www.discogs.com/artist/12345-Wire")).toBe(
			null,
		);
		expect(parseReleaseId("https://www.discogs.com/master/98765")).toBe(null);
		expect(parseReleaseId("")).toBe(null);
	});
});

describe("buildSearchUrl", () => {
	const params = (over = {}) => ({
		artist: "",
		title: "",
		country: "",
		year: "",
		...over,
	});

	it("maps artist/title to the Discogs param names", () => {
		const url = buildSearchUrl(params({ artist: "Led Zeppelin", title: "IV" }));
		expect(url.searchParams.get("type")).toBe("release");
		expect(url.searchParams.get("artist")).toBe("Led Zeppelin");
		expect(url.searchParams.get("release_title")).toBe("IV");
	});

	it("includes country and a valid 4-digit year", () => {
		const url = buildSearchUrl(params({ country: "UK", year: "1971" }));
		expect(url.searchParams.get("country")).toBe("UK");
		expect(url.searchParams.get("year")).toBe("1971");
	});

	it("omits empty fields", () => {
		const url = buildSearchUrl(params({ artist: "Pixies" }));
		expect(url.searchParams.has("release_title")).toBe(false);
		expect(url.searchParams.has("country")).toBe(false);
		expect(url.searchParams.has("year")).toBe(false);
	});

	it("trims whitespace before setting params", () => {
		const url = buildSearchUrl(
			params({ artist: "  Björk  ", country: " IS ", year: " 1997 " }),
		);
		expect(url.searchParams.get("artist")).toBe("Björk");
		expect(url.searchParams.get("country")).toBe("IS");
		expect(url.searchParams.get("year")).toBe("1997");
	});

	it("drops a non-4-digit year rather than sending junk", () => {
		expect(
			buildSearchUrl(params({ year: "71" })).searchParams.has("year"),
		).toBe(false);
		expect(
			buildSearchUrl(params({ year: "nineteen" })).searchParams.has("year"),
		).toBe(false);
	});
});

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

	it('does not default a non-vinyl "Album" to 12"', () => {
		// "Album" folds to type LP, but a CD is not a 12" record — the vinyl guard
		// keeps the size null here.
		expect(parseSizeAndType(["CD", "Album", "Reissue"])).toEqual({
			size: null,
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
