import { describe, expect, it } from "vitest";

import {
	type MatchRecord,
	matchAmazonToRecord,
	parseAmazonOrderHistory,
	parseCsv,
} from "./amazon-csv";

describe("parseCsv", () => {
	it("handles quoted fields with commas, quotes, and newlines", () => {
		const csv = 'a,b,c\n"x,1","say ""hi""","line\nbreak"';
		expect(parseCsv(csv)).toEqual([
			["a", "b", "c"],
			["x,1", 'say "hi"', "line\nbreak"],
		]);
	});

	it("tolerates CRLF line endings and a missing final newline", () => {
		expect(parseCsv("a,b\r\n1,2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});
});

describe("parseAmazonOrderHistory", () => {
	const csv = [
		'"Order Date","Title","ASIN","Category","Quantity"',
		'"2014-07-28","Led Zeppelin IV [VINYL]","B00M30T9F2","ABIS_MUSIC","1"',
		'"2015-01-02","Some Novel","1234567890","ABIS_BOOK","1"', // ISBN, not a B-ASIN
		'"2016-03-04","Kind of Blue [VINYL]","B000002ADT","abis_music","1"',
		'"2016-03-05","Kind of Blue [VINYL]","B000002ADT","abis_music","1"', // dup ASIN
	].join("\n");

	it("keeps deduped music rows with a physical (B-prefixed) ASIN", () => {
		const items = parseAmazonOrderHistory(csv);
		expect(items.map((i) => i.asin)).toEqual(["B00M30T9F2", "B000002ADT"]);
		expect(items[0]).toMatchObject({
			asin: "B00M30T9F2",
			title: "Led Zeppelin IV [VINYL]",
			category: "ABIS_MUSIC",
			orderDate: "2014-07-28",
		});
	});

	it("returns [] when the ASIN/Title columns are absent", () => {
		expect(parseAmazonOrderHistory("Foo,Bar\n1,2")).toEqual([]);
	});

	it("keeps rows when there's no Category column (can't tell — keep)", () => {
		const noCat = ['"Title","ASIN"', '"Wire Pink Flag","B00XYZ1234"'].join(
			"\n",
		);
		expect(parseAmazonOrderHistory(noCat).map((i) => i.asin)).toEqual([
			"B00XYZ1234",
		]);
	});
});

describe("matchAmazonToRecord", () => {
	const records: Array<MatchRecord> = [
		{ id: 1, artist: "Led Zeppelin", title: "Led Zeppelin IV" },
		{ id: 2, artist: "Miles Davis", title: "Kind of Blue" },
		{ id: 3, artist: "Wire", title: "Pink Flag" },
	];

	it("matches an Amazon title to the right record despite format noise", () => {
		expect(
			matchAmazonToRecord(
				{
					asin: "B00M30T9F2",
					title: "Led Zeppelin IV [VINYL]",
					category: null,
					orderDate: null,
				},
				records,
			),
		).toBe(1);
		expect(
			matchAmazonToRecord(
				{
					asin: "B000002ADT",
					title: "Kind of Blue (Deluxe Edition) [VINYL]",
					category: null,
					orderDate: null,
				},
				records,
			),
		).toBe(2);
	});

	it("returns null when nothing is close enough", () => {
		expect(
			matchAmazonToRecord(
				{
					asin: "B00000000X",
					title: "Taylor Swift 1989 [VINYL]",
					category: null,
					orderDate: null,
				},
				records,
			),
		).toBeNull();
	});
});
