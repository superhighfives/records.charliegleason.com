import { describe, expect, it } from "vitest";

import {
	findCheapestVinyl,
	isVinylTitle,
	matchesAlbum,
	parsePlaidRoomPrice,
	parseShipping,
	toOffers,
	toPlaidRoomOffers,
} from "./sellers";

describe("parseShipping", () => {
	it("reads an explicit dollar amount", () => {
		expect(parseShipping("$5.99 delivery")).toBe(5.99);
		expect(parseShipping("$12 delivery")).toBe(12);
	});

	it("treats free *shipping/delivery* as $0", () => {
		expect(parseShipping("Free delivery")).toBe(0);
		expect(parseShipping("Free shipping")).toBe(0);
		expect(parseShipping("Free delivery, Free 30-day returns")).toBe(0);
	});

	it("does not infer free shipping from unrelated 'free' wording", () => {
		// Free *returns* says nothing about the shipping cost → unknown, not $0.
		expect(parseShipping("Free 30-day returns")).toBeNull();
	});

	it("prefers a stated price over the word 'free' (free returns, paid shipping)", () => {
		expect(parseShipping("$4.99 delivery, Free 30-day returns")).toBe(4.99);
	});

	it("treats conditional free shipping (a threshold) as unknown, not $0 or the threshold", () => {
		expect(parseShipping("Free delivery on $50+")).toBeNull();
		expect(parseShipping("Free shipping over $35")).toBeNull();
	});

	it("returns null when shipping is unknown", () => {
		expect(parseShipping(undefined)).toBeNull();
		expect(parseShipping("")).toBeNull();
		expect(parseShipping("Get it by Fri, Jun 27")).toBeNull();
	});
});

describe("isVinylTitle", () => {
	it("accepts vinyl titles — including the common case with no format word", () => {
		expect(isVinylTitle("Rumours (Vinyl)")).toBe(true);
		expect(isVinylTitle("Rumours [LP]")).toBe(true);
		// Real vinyl listings frequently omit any format word in the title.
		expect(isVinylTitle("The Tallest Man On Earth - I Love You")).toBe(true);
	});

	it("rejects competing formats and merch", () => {
		expect(isVinylTitle("Rumours [CD]")).toBe(false);
		expect(isVinylTitle("Rumours (Cassette)")).toBe(false);
		expect(isVinylTitle("Rumours Digital Album")).toBe(false);
		expect(isVinylTitle("Rumours Tour T-Shirt")).toBe(false);
		expect(isVinylTitle("Rumours Vinyl + CD bundle")).toBe(false);
	});
});

describe("matchesAlbum", () => {
	it("requires every distinctive album word to appear", () => {
		expect(matchesAlbum("Colors (Vinyl)", ["colors"])).toBe(true);
		// A different release of the same artist must not pass as "Colors".
		expect(matchesAlbum("I Love You Fever Dream (Vinyl)", ["colors"])).toBe(
			false,
		);
	});

	it("defers to the vinyl filter when there's nothing distinctive to match", () => {
		expect(matchesAlbum("anything", [])).toBe(true);
	});
});

describe("toOffers", () => {
	it("keeps only vinyl pressings of the searched album", () => {
		const offers = toOffers(
			[
				{
					source: "right",
					title: "The Tallest Man on Earth - Colors (Vinyl LP)",
					product_link: "https://right.example/x",
					extracted_price: 20,
					delivery: "Free delivery",
				},
				{
					source: "wrong-album",
					title: "The Tallest Man on Earth - I Love You (Vinyl LP)",
					product_link: "https://wrong.example/x",
					extracted_price: 10,
					delivery: "Free delivery",
				},
				{
					source: "wrong-format",
					title: "The Tallest Man on Earth - Colors (CD)",
					product_link: "https://cd.example/x",
					extracted_price: 5,
					delivery: "Free delivery",
				},
			],
			"Colors - Single",
		);
		expect(offers.map((o) => o.seller)).toEqual(["right"]);
	});

	it("sorts by total cost incl. shipping, not item price", () => {
		const offers = toOffers(
			[
				{
					source: "A",
					title: "Zed (Vinyl)",
					product_link: "https://a.example/x",
					extracted_price: 20,
					delivery: "Free delivery",
				},
				{
					source: "B",
					title: "Zed (Vinyl)",
					product_link: "https://b.example/x",
					extracted_price: 18,
					delivery: "$5.00 delivery",
				},
			],
			"Zed",
		);
		// B is cheaper on item ($18) but $23 total; A is $20 with free shipping.
		expect(offers.map((o) => o.seller)).toEqual(["A", "B"]);
		expect(offers[0].totalPrice).toBe(20);
		expect(offers[0].freeShipping).toBe(true);
		expect(offers[1].totalPrice).toBe(23);
	});

	it("ranks offers with unknown shipping after any known all-in total", () => {
		const offers = toOffers(
			[
				{
					source: "cheap-but-unknown",
					title: "Zed (Vinyl)",
					product_link: "https://u.example/x",
					extracted_price: 15, // tempting item price, but shipping unknown
					delivery: "Get it Friday",
				},
				{
					source: "known-total",
					title: "Zed (Vinyl)",
					product_link: "https://k.example/x",
					extracted_price: 20,
					delivery: "Free delivery",
				},
			],
			"Zed",
		);
		// We can't claim the $15 unknown-shipping offer beats a real $20 all-in.
		expect(offers.map((o) => o.seller)).toEqual([
			"known-total",
			"cheap-but-unknown",
		]);
		expect(offers[1].shippingPrice).toBeNull();
		expect(offers[1].freeShipping).toBe(false);
	});

	it("drops rows without a usable price or safe http(s) buy link", () => {
		const offers = toOffers(
			[
				{
					source: "no price",
					title: "Zed (Vinyl)",
					product_link: "https://np.example/x",
				},
				{
					source: "zero price",
					title: "Zed (Vinyl)",
					product_link: "https://zp.example/x",
					extracted_price: 0,
				},
				{ source: "no link", title: "Zed (Vinyl)", extracted_price: 10 },
				{
					source: "unsafe link",
					title: "Zed (Vinyl)",
					product_link: "javascript:alert(1)",
					extracted_price: 5,
					delivery: "Free delivery",
				},
				{
					source: "ok",
					title: "Zed (Vinyl)",
					product_link: "https://ok.example/x",
					extracted_price: 10,
					delivery: "Free delivery",
				},
			],
			"Zed",
		);
		expect(offers).toHaveLength(1);
		expect(offers[0].seller).toBe("ok");
	});

	it("falls back to link when product_link is absent, and labels missing sellers", () => {
		const [offer] = toOffers(
			[
				{
					title: "Zed (Vinyl)",
					link: "https://shop.example/item",
					extracted_price: 9.5,
					delivery: "Free delivery",
				},
			],
			"Zed",
		);
		expect(offer.url).toBe("https://shop.example/item");
		expect(offer.seller).toBe("Unknown seller");
	});
});

describe("parsePlaidRoomPrice", () => {
	it("parses a formatted money string", () => {
		expect(parsePlaidRoomPrice("$25.00")).toBe(25);
		expect(parsePlaidRoomPrice("$1,234.50")).toBe(1234.5);
		expect(parsePlaidRoomPrice("27.99")).toBe(27.99);
	});

	it("passes a plausible dollar number through unchanged", () => {
		expect(parsePlaidRoomPrice(25)).toBe(25);
		expect(parsePlaidRoomPrice(27.99)).toBe(27.99);
	});

	it("reads a four-figure integer as cents (Shopify sometimes reports cents)", () => {
		expect(parsePlaidRoomPrice(2500)).toBe(25);
		expect(parsePlaidRoomPrice(3499)).toBe(34.99);
	});

	it("returns null for a missing, zero, or unparseable price", () => {
		expect(parsePlaidRoomPrice(undefined)).toBeNull();
		expect(parsePlaidRoomPrice(0)).toBeNull();
		expect(parsePlaidRoomPrice("")).toBeNull();
		expect(parsePlaidRoomPrice("Sold out")).toBeNull();
	});
});

describe("toPlaidRoomOffers", () => {
	it("keeps in-stock vinyl pressings of the searched album, cheapest first", () => {
		const offers = toPlaidRoomOffers(
			[
				{
					title: "The Tallest Man on Earth - Colors",
					url: "/products/colors?_pos=1",
					price: "$28.00",
					available: true,
				},
				{
					title: "The Tallest Man on Earth - Colors (Indie Exclusive)",
					url: "/products/colors-indie",
					price: 2500,
					available: true,
				},
			],
			"The Tallest Man on Earth",
			"Colors",
		);
		expect(offers.map((o) => o.itemPrice)).toEqual([25, 28]);
		expect(offers[0].seller).toBe("Plaid Room Records");
		expect(offers[0].url).toBe(
			"https://www.plaidroomrecords.com/products/colors-indie",
		);
		// Shipping is never stated by predictive search.
		expect(offers[0].shippingPrice).toBeNull();
		expect(offers[0].freeShipping).toBe(false);
	});

	it("leaves an already-absolute url untouched", () => {
		const [offer] = toPlaidRoomOffers(
			[
				{
					title: "Someone - Zed",
					url: "https://www.plaidroomrecords.com/products/zed",
					price: 20,
				},
			],
			"Someone",
			"Zed",
		);
		expect(offer.url).toBe("https://www.plaidroomrecords.com/products/zed");
	});

	it("drops the wrong album, wrong format, sold-out, and priceless rows", () => {
		const offers = toPlaidRoomOffers(
			[
				{
					title: "Someone - Other Record",
					url: "/products/other",
					price: 20,
				},
				{ title: "Someone - Zed (CD)", url: "/products/zed-cd", price: 12 },
				{
					title: "Someone - Zed",
					url: "/products/zed-oos",
					price: 20,
					available: false,
				},
				{ title: "Someone - Zed", url: "/products/zed-noprice" },
				{ title: "Someone - Zed", url: "/products/zed", price: "$20.00" },
			],
			"Someone",
			"Zed",
		);
		expect(offers).toHaveLength(1);
		expect(offers[0].url).toBe("https://www.plaidroomrecords.com/products/zed");
	});

	it("requires the artist to match, not just the album word", () => {
		const offers = toPlaidRoomOffers(
			[{ title: "Another Band - Colors", url: "/products/x", price: 20 }],
			"The Tallest Man on Earth",
			"Colors",
		);
		expect(offers).toHaveLength(0);
	});
});

describe("findCheapestVinyl", () => {
	it("is a no-op (null) when SERPAPI_KEY is unset — never throws, never fetches", async () => {
		await expect(
			findCheapestVinyl("Radiohead", "In Rainbows"),
		).resolves.toBeNull();
	});
});
