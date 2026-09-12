import { describe, expect, it } from "vitest";

import {
	type AmazonItem,
	amazonImageUrl,
	type MatchRecord,
	marketplaceCountry,
	matchAmazonToRecord,
	pairPurchasesToRecords,
	parseAmazonOrderHistory,
	parseCsv,
} from "./amazon-csv";

const item = (asin: string, title: string): AmazonItem => ({
	asin,
	title,
	category: null,
	orderDate: null,
	country: null,
});

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

	it("reads the real UK export shape: 'Product Name', no Category, ISO date", () => {
		// Verbatim header + row from a Retail.OrderHistory.csv (Amazon.co.uk), which
		// uses "Product Name" (not "Title"), an unquoted ASIN, ISO-8601 dates, and
		// no Category column — plus commas inside quoted address fields.
		const real = [
			'ASIN,"Billing Address","Carrier Name & Tracking Number",Currency,"Gift Message","Gift Recipient Contact","Gift Sender Name","Item Serial Number","Order Date","Order ID","Order Status","Original Quantity","Payment Method Type","Product Condition","Product Name","Purchase Order Number","Ship Date","Shipment Item Subtotal","Shipment Item Subtotal Tax","Shipment Status","Shipping Address","Shipping Charge","Shipping Option","Total Amount","Total Discounts","Unit Price","Unit Price Tax",Website',
			'B00PCI1HCU,"Charlie Gleason 10 Seville House 11 And A Half Wapping High St London London E1W1NX United Kingdom","AMZN_UK(Q22207405383)",GBP,"Not Available","Not Available","Not Available","Not Available",2016-10-09T17:43:27Z,205-1154491-4153944,Closed,1,"Visa - 9225",New,"The Black Parade [VINYL]","Not Applicable",2016-10-12T18:58:11Z,9.16,1.83,Shipped,"Charlie Gleason c/o Unbound, Unit 18, Waterside 44-48 Wharf Road London London N1 7UX United Kingdom",0,premium-rfu-uk,10.99,0,9.16,1.83,Amazon.co.uk',
		].join("\n");
		expect(parseAmazonOrderHistory(real)).toEqual([
			{
				asin: "B00PCI1HCU",
				title: "The Black Parade [VINYL]",
				category: null,
				orderDate: "2016-10-09T17:43:27Z",
				country: "UK", // derived from Website=Amazon.co.uk
			},
		]);
	});

	it("matches that purchase to the right record despite artist-less title", () => {
		// Amazon's Product Name is often the album alone — the matcher leans on the
		// title tokens against the record's artist + title.
		expect(
			matchAmazonToRecord(
				{
					asin: "B00PCI1HCU",
					title: "The Black Parade [VINYL]",
					category: null,
					orderDate: "2016-10-09T17:43:27Z",
					country: "UK",
				},
				[
					{ id: 1, artist: "Arcade Fire", title: "Funeral" },
					{ id: 2, artist: "My Chemical Romance", title: "The Black Parade" },
				],
			),
		).toBe(2);
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
					country: null,
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
					country: null,
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
					country: null,
				},
				records,
			),
		).toBeNull();
	});
});

describe("matchAmazonToRecord — gates against false matches", () => {
	// The real false positives from a live import: one incidental shared word.
	it("rejects an incidental ARTIST-word overlap (not an album-title match)", () => {
		const dirtyProjectors = [
			{ id: 1, artist: "Dirty Projectors", title: "Bitte Orca" },
		];
		// "Dirty" is the artist, not the album — must not match Janelle Monáe's album.
		expect(
			matchAmazonToRecord(
				item("B1", "Dirty Computer [VINYL]"),
				dirtyProjectors,
			),
		).toBeNull();

		const jeffWayne = [
			{
				id: 1,
				artist: "Jeff Wayne",
				title: "Jeff Wayne's Musical Version Of The War Of The Worlds",
			},
		];
		expect(
			matchAmazonToRecord(item("B2", "God of War (PS4)"), jeffWayne),
		).toBeNull();
	});

	it("rejects a one-common-word album title buried in an unrelated product", () => {
		const beyonce = [{ id: 1, artist: "Beyoncé", title: "Lemonade" }];
		// The album title word appears, but it's a tiny slice of the product name.
		expect(
			matchAmazonToRecord(
				item(
					"B1",
					"Morrisons No Added Sugar Cloudy Lemonade Drink, 6 x 330ml Cans",
				),
				beyonce,
			),
		).toBeNull();
	});

	it("still matches when the Amazon title abbreviates a long album title", () => {
		const bowie = [
			{
				id: 1,
				artist: "David Bowie",
				title: "The Rise and Fall of Ziggy Stardust and the Spiders from Mars",
			},
		];
		expect(
			matchAmazonToRecord(item("B1", "Ziggy Stardust [VINYL]"), bowie),
		).toBe(1);
	});

	it("still matches a title-complete hit despite Amazon edition cruft", () => {
		const miley = [{ id: 1, artist: "Miley Cyrus", title: "Bangerz" }];
		expect(
			matchAmazonToRecord(
				item(
					"B1",
					"Bangerz: 10th Anniversary (Sea Glass colour vinyl) [VINYL]",
				),
				miley,
			),
		).toBe(1);
	});
});

describe("marketplaceCountry", () => {
	it("maps known Amazon marketplaces to Discogs country names", () => {
		expect(marketplaceCountry("Amazon.co.uk")).toBe("UK");
		expect(marketplaceCountry("Amazon.com")).toBe("US");
		expect(marketplaceCountry("amazon.de")).toBe("Germany");
	});
	it("is null for unknown or missing marketplaces", () => {
		expect(marketplaceCountry("Amazon.example")).toBeNull();
		expect(marketplaceCountry(null)).toBeNull();
	});
});

describe("amazonImageUrl", () => {
	it("builds the ASIN product-image URL with a size", () => {
		expect(amazonImageUrl("B00PCI1HCU")).toBe(
			"https://m.media-amazon.com/images/P/B00PCI1HCU.01._SL160_.jpg",
		);
		expect(amazonImageUrl("B00PCI1HCU", 80)).toBe(
			"https://m.media-amazon.com/images/P/B00PCI1HCU.01._SL80_.jpg",
		);
	});
});

describe("pairPurchasesToRecords", () => {
	const records: Array<MatchRecord> = [
		{ id: 1, artist: "My Chemical Romance", title: "The Black Parade" },
		{ id: 2, artist: "Miles Davis", title: "Kind of Blue" },
	];

	it("assigns each purchase to its matching record, ignoring non-matches", () => {
		const pairs = pairPurchasesToRecords(
			[
				item("B1", "The Black Parade [VINYL]"),
				item("B2", "Kind of Blue [VINYL]"),
				item("B3", "Stainless Steel Mixing Bowl"),
			],
			records,
		);
		expect(pairs.map((p) => [p.item.asin, p.record.id])).toEqual([
			["B1", 1],
			["B2", 2],
		]);
	});

	it("never claims one record for two purchases (no double-assignment)", () => {
		const pairs = pairPurchasesToRecords(
			[
				item("B1", "The Black Parade [VINYL]"),
				item("B2", "The Black Parade (Live At Home) [VINYL]"),
			],
			[records[0]],
		);
		expect(pairs.length).toBe(1);
	});
});
