import { env } from "cloudflare:workers";

/**
 * "Where to buy" lookup for digest suggestions. Queries SerpApi's Google Shopping
 * engine for a record across N sellers (Amazon, eBay, Discogs, indie shops, …),
 * normalizes price + shipping, and returns the cheapest by total cost.
 *
 * https://serpapi.com/google-shopping-api — single `SERPAPI_KEY` secret, one GET.
 * The key is optional: with no key (e.g. preview/local) the lookup is a no-op and
 * the digest simply omits the price line. Any network/parse failure also yields
 * null so a flaky pricing call can never break the email.
 *
 * Free tier is 250 searches/mo; responses are cached (see CACHE_TTL) so the same
 * album recurring across daily digests reuses one lookup instead of spending a call.
 */

const ENDPOINT = "https://serpapi.com/search.json";
// 3 days: long enough that albums lingering in the Last.fm top-list across daily
// digests don't each cost a search, short enough that prices stay broadly current.
const CACHE_TTL = 60 * 60 * 24 * 3;
const MAX_OFFERS = 60; // light cap before we sort + pick the cheapest

export interface SellerOffer {
	seller: string; // merchant name, e.g. "Amazon.com"
	url: string; // buy link for this specific offer
	itemPrice: number; // USD
	shippingPrice: number | null; // USD; 0 = free, null = not stated by the seller
	totalPrice: number; // itemPrice + (shippingPrice ?? 0) — what we sort on
	freeShipping: boolean;
}

export interface SellerSummary {
	cheapest: SellerOffer;
	offerCount: number;
}

/**
 * Parse SerpApi's free-text `delivery` string into a shipping cost in USD.
 * Examples: "Free delivery" → 0, "$5.99 delivery" → 5.99,
 * "Free delivery, Free 30-day returns" → 0, "" / "Get it by Fri" → null (unknown).
 */
export function parseShipping(delivery: string | undefined): number | null {
	if (!delivery) return null;
	const text = delivery.toLowerCase();
	const dollars = text.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
	if (dollars) return Number.parseFloat(dollars[1]);
	// "Free delivery" but also generic "free shipping" / "free returns" wording.
	if (text.includes("free")) return 0;
	return null;
}

interface ShoppingResult {
	source?: string;
	title?: string;
	link?: string;
	product_link?: string;
	extracted_price?: number;
	delivery?: string;
}

/**
 * Normalize raw Google Shopping rows into offers sorted cheapest-first by total
 * cost. Unknown shipping is treated as $0 for ranking (we can't invent a number),
 * but is surfaced as such in the rendered line. Pure + exported for testing.
 */
export function toOffers(results: Array<ShoppingResult>): Array<SellerOffer> {
	return results
		.filter(
			(r) => typeof r.extracted_price === "number" && r.extracted_price > 0,
		)
		.map((r) => {
			const itemPrice = r.extracted_price as number;
			const shippingPrice = parseShipping(r.delivery);
			return {
				seller: (r.source ?? "").trim() || "Unknown seller",
				url: r.product_link || r.link || "",
				itemPrice,
				shippingPrice,
				totalPrice: itemPrice + (shippingPrice ?? 0),
				freeShipping: shippingPrice === 0,
			} satisfies SellerOffer;
		})
		.filter((o) => o.url)
		.sort((a, b) => a.totalPrice - b.totalPrice);
}

/** Build the SerpApi request URL. Bias the query toward vinyl pressings. */
function buildUrl(artist: string, title: string): URL {
	const url = new URL(ENDPOINT);
	url.searchParams.set("engine", "google_shopping");
	url.searchParams.set("q", `${artist} ${title} vinyl record`);
	url.searchParams.set("gl", "us"); // US store → USD, US shipping (Prime context)
	url.searchParams.set("hl", "en");
	url.searchParams.set("api_key", env.SERPAPI_KEY as string);
	return url;
}

/**
 * Find the cheapest place to buy a record on vinyl, by total cost incl. shipping.
 * Returns null when pricing is unavailable (no key, no results, or any error).
 */
export async function findCheapestVinyl(
	artist: string,
	title: string,
): Promise<SellerSummary | null> {
	if (!env.SERPAPI_KEY) return null;
	try {
		const url = buildUrl(artist, title);

		// Cache on a key that excludes the API key (don't leak the secret into the
		// cache namespace, and let the same query hit regardless of key rotation).
		// `caches.default` is the Workers runtime cache (not in the DOM lib's type).
		const cache = (caches as unknown as { default: Cache }).default;
		const cacheKey = new Request(
			`https://serpapi-cache/${encodeURIComponent(`${artist}|${title}`)}`,
		);
		const cached = await cache.match(cacheKey);
		const results: Array<ShoppingResult> = cached
			? await cached.json()
			: await (async () => {
					const res = await fetch(url);
					if (!res.ok) return [];
					const data = (await res.json()) as {
						shopping_results?: Array<ShoppingResult>;
					};
					const rows = (data.shopping_results ?? []).slice(0, MAX_OFFERS);
					await cache.put(
						cacheKey,
						new Response(JSON.stringify(rows), {
							headers: {
								"content-type": "application/json",
								"cache-control": `max-age=${CACHE_TTL}`,
							},
						}),
					);
					return rows;
				})();

		const offers = toOffers(results);
		if (offers.length === 0) return null;
		return { cheapest: offers[0], offerCount: offers.length };
	} catch {
		return null;
	}
}
