import { describe, expect, it } from "vitest";

import { findCheapestVinyl, parseShipping, toOffers } from "./sellers";

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

	it("returns null when shipping is unknown", () => {
		expect(parseShipping(undefined)).toBeNull();
		expect(parseShipping("")).toBeNull();
		expect(parseShipping("Get it by Fri, Jun 27")).toBeNull();
	});
});

describe("toOffers", () => {
	it("sorts by total cost incl. shipping, not item price", () => {
		const offers = toOffers([
			{
				source: "A",
				product_link: "https://a.example/x",
				extracted_price: 20,
				delivery: "Free delivery",
			},
			{
				source: "B",
				product_link: "https://b.example/x",
				extracted_price: 18,
				delivery: "$5.00 delivery",
			},
		]);
		// B is cheaper on item ($18) but $23 total; A is $20 with free shipping.
		expect(offers.map((o) => o.seller)).toEqual(["A", "B"]);
		expect(offers[0].totalPrice).toBe(20);
		expect(offers[0].freeShipping).toBe(true);
		expect(offers[1].totalPrice).toBe(23);
	});

	it("ranks offers with unknown shipping after any known all-in total", () => {
		const offers = toOffers([
			{
				source: "cheap-but-unknown",
				product_link: "https://u.example/x",
				extracted_price: 15, // tempting item price, but shipping unknown
				delivery: "Get it Friday",
			},
			{
				source: "known-total",
				product_link: "https://k.example/x",
				extracted_price: 20,
				delivery: "Free delivery",
			},
		]);
		// We can't claim the $15 unknown-shipping offer beats a real $20 all-in.
		expect(offers.map((o) => o.seller)).toEqual([
			"known-total",
			"cheap-but-unknown",
		]);
		expect(offers[1].shippingPrice).toBeNull();
		expect(offers[1].freeShipping).toBe(false);
	});

	it("drops rows without a usable price or safe http(s) buy link", () => {
		const offers = toOffers([
			{ source: "no price", product_link: "https://np.example/x" },
			{
				source: "zero price",
				product_link: "https://zp.example/x",
				extracted_price: 0,
			},
			{ source: "no link", extracted_price: 10 },
			{
				source: "unsafe link",
				product_link: "javascript:alert(1)",
				extracted_price: 5,
				delivery: "Free delivery",
			},
			{
				source: "ok",
				product_link: "https://ok.example/x",
				extracted_price: 10,
				delivery: "Free delivery",
			},
		]);
		expect(offers).toHaveLength(1);
		expect(offers[0].seller).toBe("ok");
	});

	it("falls back to link when product_link is absent, and labels missing sellers", () => {
		const [offer] = toOffers([
			{
				link: "https://shop.example/item",
				extracted_price: 9.5,
				delivery: "Free delivery",
			},
		]);
		expect(offer.url).toBe("https://shop.example/item");
		expect(offer.seller).toBe("Unknown seller");
	});
});

describe("findCheapestVinyl", () => {
	it("is a no-op (null) when SERPAPI_KEY is unset — never throws, never fetches", async () => {
		await expect(
			findCheapestVinyl("Radiohead", "In Rainbows"),
		).resolves.toBeNull();
	});
});
