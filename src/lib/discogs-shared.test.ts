import { describe, expect, it } from "vitest";

import {
	buildBarcodeSearchUrl,
	classifyQuery,
	cleanArtistName,
	mapMasterDetail,
	mapMasterSearchResult,
	mapReleaseCandidate,
	mapReleaseSearchResult,
	masterDetailToCandidate,
	parseAsin,
	parseBarcode,
	parseDiscCount,
	parseSizeAndType,
} from "./discogs-shared";

describe("cleanArtistName", () => {
	it("strips a disambiguation suffix", () => {
		expect(cleanArtistName("Ceres (3)")).toBe("Ceres");
		expect(cleanArtistName("Wire (2)")).toBe("Wire");
	});

	it("un-inverts a trailing sort article", () => {
		expect(cleanArtistName("Frames, The")).toBe("The Frames");
		expect(cleanArtistName("Streets, A")).toBe("A Streets");
		expect(cleanArtistName("XX, An")).toBe("An XX");
	});

	it("handles both a suffix and an inverted article together", () => {
		expect(cleanArtistName("Frames, The (2)")).toBe("The Frames");
		// Discogs also emits the disambiguation suffix before the inverted
		// article rather than at the very end.
		expect(cleanArtistName("Frames (2), The")).toBe("The Frames");
	});

	it("normalises the article's casing regardless of the input's", () => {
		expect(cleanArtistName("Frames, the")).toBe("The Frames");
		expect(cleanArtistName("Frames, THE")).toBe("The Frames");
	});

	it("leaves ordinary names untouched", () => {
		expect(cleanArtistName("Wire")).toBe("Wire");
		expect(cleanArtistName("The Frames")).toBe("The Frames");
	});
});

describe("mapReleaseSearchResult", () => {
	it("maps a populated release search row", () => {
		const c = mapReleaseSearchResult({
			id: 123,
			title: "Wire - Pink Flag",
			year: "1977",
			label: ["Harvest"],
			genre: ["Rock"],
			format: ["Vinyl", "LP", "Album"],
			country: "UK",
			uri: "/release/123",
		});
		expect(c).toMatchObject({
			discogsId: "123",
			artist: "Wire",
			title: "Pink Flag",
			label: "Harvest",
			genre: "Rock",
			country: "UK",
		});
	});

	it('nulls empty label/genre arrays instead of the string "undefined"', () => {
		// The bug this guards: `String([][0])` is `"undefined"`, so an empty array
		// would otherwise persist + display the literal word "undefined".
		const c = mapReleaseSearchResult({
			id: 1,
			title: "A - B",
			label: [],
			genre: [],
		});
		expect(c.label).toBeNull();
		expect(c.genre).toBeNull();
	});
});

describe("mapMasterSearchResult", () => {
	it('nulls an empty genre array instead of the string "undefined"', () => {
		const c = mapMasterSearchResult({ id: 9, title: "A - B", genre: [] });
		expect(c.genre).toBeNull();
	});
});

describe("mapReleaseCandidate", () => {
	it("shapes a full release payload into a candidate", () => {
		const c = mapReleaseCandidate(
			{
				id: 30268103,
				artists_sort: "Wire (2)",
				title: "Pink Flag",
				year: 1977,
				country: "UK",
				genres: ["Rock"],
				labels: [{ name: "Harvest", catno: "SHSP 4076" }],
				formats: [{ name: "Vinyl", qty: "1", descriptions: ["LP", "Album"] }],
				master_id: 12345,
				master_url: "https://api.discogs.com/masters/12345",
				uri: "/release/30268103-Wire-Pink-Flag",
				images: [{ type: "primary", uri150: "https://img/150.jpg" }],
			},
			"30268103",
		);
		expect(c).toMatchObject({
			discogsId: "30268103",
			masterId: "12345",
			artist: "Wire", // disambiguation suffix stripped
			title: "Pink Flag",
			year: 1977,
			label: "Harvest",
			catno: "SHSP 4076",
			country: "UK",
			size: '12"',
			type: "LP",
			thumb: "https://img/150.jpg",
			discogsUrl: "https://www.discogs.com/release/30268103-Wire-Pink-Flag",
		});
	});

	it("returns a null thumb when images are absent (unauthenticated fetch)", () => {
		const c = mapReleaseCandidate(
			{ id: 1, title: "X", uri: "/release/1" },
			"1",
		);
		expect(c.thumb).toBeNull();
		expect(c.discogsId).toBe("1");
	});

	it("normalises a `none` catalog number and a zero master_id to null", () => {
		const c = mapReleaseCandidate(
			{ id: 2, title: "Y", labels: [{ catno: "none" }], master_id: 0 },
			"2",
		);
		expect(c.catno).toBeNull();
		expect(c.masterId).toBeNull();
		// No `uri` → fall back to a canonical release URL built from the id.
		expect(c.discogsUrl).toBe("https://www.discogs.com/release/2");
	});
});

describe("parseDiscCount", () => {
	it("defaults to 1 for missing or empty input", () => {
		expect(parseDiscCount(null)).toBe(1);
		expect(parseDiscCount(undefined)).toBe(1);
		expect(parseDiscCount("")).toBe(1);
		expect(parseDiscCount([])).toBe(1);
	});

	it("reads qty off a formats[] array, vinyl entries only", () => {
		expect(
			parseDiscCount([{ name: "Vinyl", qty: "2" }, { name: "Insert" }]),
		).toBe(2);
		expect(
			parseDiscCount([
				{ name: "Vinyl", qty: "2" },
				{ name: "Vinyl", qty: "3" },
			]),
		).toBe(3);
		expect(parseDiscCount([{ name: "Box Set", qty: "1" }])).toBe(1);
	});

	it("parses an 'NxLP'-style joined format string", () => {
		expect(parseDiscCount("2xLP")).toBe(2);
		expect(parseDiscCount("2×LP")).toBe(2);
		expect(parseDiscCount(["Album", "2xLP", "Gatefold"])).toBe(2);
	});

	it("falls back to 1 when the count is encoded against the size instead", () => {
		// Discogs sometimes writes the count against the disc size (`2×12"`)
		// rather than the format (`2xLP`) — parseDiscCount doesn't parse that
		// shape today, so it defaults to 1 rather than misreading it.
		expect(parseDiscCount('2×12", 45 RPM, EP')).toBe(1);
	});
});

describe("parseSizeAndType", () => {
	it("treats the 'Single LP' capture preset as a one-disc LP, not a 7\" single", () => {
		expect(parseSizeAndType("Single LP")).toEqual({ size: '12"', type: "LP" });
	});

	it("still reads a bare 'single' as a Single", () => {
		expect(parseSizeAndType("single")).toEqual({ size: null, type: "Single" });
	});
});

describe("mapMasterDetail + masterDetailToCandidate", () => {
	it("shapes a master payload and derives a candidate", () => {
		const detail = mapMasterDetail(
			{
				id: 12345,
				title: "Pink Flag",
				year: 1977,
				genres: ["Rock"],
				artists: [{ name: "Wire (2)" }],
				main_release: 999,
				uri: "/master/12345-Wire-Pink-Flag",
				images: [{ type: "primary", uri: "https://img/full.jpg" }],
			},
			"12345",
		);
		expect(detail).toMatchObject({
			masterId: "12345",
			mainReleaseId: "999",
			artist: "Wire",
			title: "Pink Flag",
			year: 1977,
			imageUrl: "https://img/full.jpg",
		});
		expect(masterDetailToCandidate(detail)).toMatchObject({
			masterId: "12345",
			artist: "Wire",
			title: "Pink Flag",
			thumb: "https://img/full.jpg",
		});
	});

	it("null imageUrl/thumb when images are absent, with a fallback masterUrl", () => {
		const detail = mapMasterDetail({ id: 7, title: "Z" }, "7");
		expect(detail.imageUrl).toBeNull();
		expect(detail.masterUrl).toBe("https://www.discogs.com/master/7");
		expect(masterDetailToCandidate(detail).thumb).toBeNull();
	});
});

describe("parseAsin", () => {
	it("accepts a B-prefixed product ASIN, normalising case", () => {
		expect(parseAsin("B00M30T9F2")).toBe("B00M30T9F2");
		expect(parseAsin("  b00m30t9f2 ")).toBe("B00M30T9F2");
	});

	it("rejects non-ASIN shapes (wrong prefix, wrong length, a bare number)", () => {
		expect(parseAsin("A00M30T9F2")).toBeNull(); // wrong prefix
		expect(parseAsin("B00M30T9F")).toBeNull(); // 9 chars
		expect(parseAsin("B00M30T9F23")).toBeNull(); // 11 chars
		expect(parseAsin("12345")).toBeNull();
		expect(parseAsin("")).toBeNull();
	});
});

describe("parseBarcode", () => {
	it("accepts 12–13 digit UPC/EAN, tolerating spaces and hyphens", () => {
		expect(parseBarcode("075678664250")).toBe("075678664250"); // UPC-A, 12
		expect(parseBarcode("0075678664250")).toBe("0075678664250"); // EAN-13
		expect(parseBarcode("0 75678 66425 0")).toBe("075678664250");
		expect(parseBarcode("075678-664250")).toBe("075678664250");
	});

	it("rejects things that aren't barcodes (year, short/long digits, catalog no.)", () => {
		expect(parseBarcode("1971")).toBeNull();
		expect(parseBarcode("12345678")).toBeNull(); // 8 digits — too short
		expect(parseBarcode("00756786642500")).toBeNull(); // 14 digits
		expect(parseBarcode("SHSP 4076")).toBeNull();
		expect(parseBarcode("")).toBeNull();
	});
});

describe("classifyQuery", () => {
	it("routes a Discogs release URL (and bare /release path) to release-url", () => {
		expect(
			classifyQuery("https://www.discogs.com/release/30268103-Wire-Pink-Flag"),
		).toEqual({ kind: "release-url", id: "30268103" });
		expect(classifyQuery("/releases/30268103")).toEqual({
			kind: "release-url",
			id: "30268103",
		});
	});

	it("routes a Discogs master URL to master-url", () => {
		expect(
			classifyQuery("https://www.discogs.com/master/12345-Some-Album"),
		).toEqual({ kind: "master-url", id: "12345" });
	});

	it("shape-detects an ASIN and a barcode", () => {
		expect(classifyQuery("B00M30T9F2")).toEqual({
			kind: "asin",
			asin: "B00M30T9F2",
		});
		expect(classifyQuery("0 75678 66425 0")).toEqual({
			kind: "barcode",
			barcode: "075678664250",
		});
	});

	it("treats a bare number and free text as keywords (too ambiguous for an id)", () => {
		expect(classifyQuery("30268103")).toEqual({
			kind: "text",
			text: "30268103",
		});
		expect(classifyQuery("Led Zeppelin IV")).toEqual({
			kind: "text",
			text: "Led Zeppelin IV",
		});
	});
});

describe("buildBarcodeSearchUrl", () => {
	it("builds a release-typed barcode search", () => {
		const url = buildBarcodeSearchUrl("075678664250", 50);
		expect(url.pathname).toBe("/database/search");
		expect(url.searchParams.get("type")).toBe("release");
		expect(url.searchParams.get("barcode")).toBe("075678664250");
		expect(url.searchParams.get("per_page")).toBe("50");
	});
});
