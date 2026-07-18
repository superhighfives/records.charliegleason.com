import { env } from "cloudflare:workers";

/**
 * "Where to buy" lookup for digest suggestions. For each record we make up to
 * three SerpApi calls plus one keyless store lookup, each independently
 * failure-tolerant (any returns the graceful fallback so a flaky pricing call
 * can never break the email):
 *
 *  1. Google Shopping (`engine=google_shopping`) — cheapest offer across sellers
 *     (Amazon, eBay, Discogs, indie shops, …), filtered to *vinyl pressings of
 *     this album* (see isVinylTitle + matchesAlbum). This is the primary line.
 *  2. Google Immersive Product (`engine=google_immersive_product`) — structured
 *     per-seller shipping/total for the chosen offer, to turn "+ shipping"
 *     unknowns into a real all-in price.
 *  3. Amazon (`engine=amazon`) — the cheapest Prime-eligible vinyl offer
 *     (Prime detected from the delivery wording; see isPrimeEligible), surfaced
 *     as an always-shown option even when it's pricier than the cheapest seller.
 *  4. Plaid Room Records (plaidroomrecords.com) — a preferred indie shop. It's a
 *     Shopify store, so we hit its keyless predictive-search JSON directly (no
 *     SerpApi, no key) for the cheapest in-stock vinyl match. See findPlaidRoom.
 *
 * The SerpApi lookups (1–3) share a single `SERPAPI_KEY` secret, via
 * https://serpapi.com/. The key is optional: with no key (e.g. preview/local)
 * the whole lookup is a no-op and the digest omits the price lines.
 *
 * SerpApi's free tier is 250 searches/mo; the weekly digest (≤10 records) costs
 * at most ~3 SerpApi calls/record. The Plaid Room call is free (not SerpApi).
 * Responses are cached (see CACHE_TTL) so a record recurring across re-runs
 * within the week reuses its lookups.
 */

const ENDPOINT = "https://serpapi.com/search.json";
// 8 days: longer than the weekly cadence so an in-week re-run reuses lookups,
// short enough that each new digest re-prices from scratch.
const CACHE_TTL = 60 * 60 * 24 * 8;
const MAX_OFFERS = 60; // light cap before we sort + pick the cheapest

export interface SellerOffer {
	seller: string; // merchant name, e.g. "Amazon.com"
	url: string; // buy link for this specific offer
	itemPrice: number; // USD
	shippingPrice: number | null; // USD; 0 = free, null = not stated by the seller
	totalPrice: number; // itemPrice + (shippingPrice ?? 0) — what we sort on
	freeShipping: boolean;
	// Internal plumbing (not rendered): SerpApi's ready-made immersive-product
	// endpoint for this result, used to fetch exact shipping for the chosen offer.
	immersiveApi?: string;
	productId?: string;
}

export interface SellerSummary {
	cheapest: SellerOffer; // cheapest qualifying vinyl offer, all-in where known
	offerCount: number; // count of qualifying vinyl offers (what the badge shows)
	prime: SellerOffer | null; // verified Amazon Prime vinyl offer, if any
	plaidRoom: SellerOffer | null; // cheapest vinyl match at Plaid Room Records, if any
}

/** Lowercase, strip accents and punctuation → space-separated tokens. */
function normalizeText(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// Words that say nothing distinctive about *which* album a listing is — format,
// edition and filler tokens. Dropped before relevance matching so a generic
// word like "single" can't make an unrelated pressing look like a match.
const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"of",
	"to",
	"in",
	"on",
	"ep",
	"lp",
	"single",
	"deluxe",
	"edition",
	"remaster",
	"remastered",
	"expanded",
	"anniversary",
	"explicit",
	"version",
	"vinyl",
	"record",
	"records",
	"album",
	"feat",
	"vol",
	"pt",
	"part",
]);

/** Distinctive words of an album title used to confirm a listing is the right release. */
function albumTokens(title: string): Array<string> {
	return Array.from(
		new Set(
			normalizeText(title)
				.split(" ")
				.filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
		),
	);
}

// There is no format field in Google Shopping, and — crucially — vinyl listings
// very often DON'T carry "vinyl"/"LP" in the title, even though they are vinyl.
// So we can't *require* a positive vinyl signal (that would hide most real
// pressings). The query is already vinyl-biased ("…vinyl record"); here we only
// reject titles that explicitly name a *competing* format or merch.
const NON_VINYL_SIGNAL =
	/\b(?:cd|compact disc|cassette|tape|digital|mp3|flac|dvd|blu[- ]?ray|t[- ]?shirt|hoodie|poster|sticker|tote|mug)\b/i;

/** True unless the title explicitly names a non-vinyl format (CD/cassette/digital/merch). */
export function isVinylTitle(title: string): boolean {
	return !NON_VINYL_SIGNAL.test(title);
}

/**
 * True when the listing title plausibly *is* the album we searched for. Guards
 * against Google Shopping returning a different (but real vinyl) release of the
 * artist when the searched album has no pressing — every distinctive album word
 * must appear. With no distinctive words to match on, defer to the vinyl filter.
 */
export function matchesAlbum(title: string, tokens: Array<string>): boolean {
	if (tokens.length === 0) return true;
	const hay = normalizeText(title);
	return tokens.every((t) => hay.includes(t));
}

/**
 * Parse SerpApi's free-text `delivery` string into a shipping cost in USD.
 * Examples: "Free delivery" → 0, "$5.99 delivery" → 5.99,
 * "Free delivery, Free 30-day returns" → 0, "Free 30-day returns" → null,
 * "Free delivery on $50+" → null (conditional, real cost unknown),
 * "" / "Get it by Fri" → null (unknown).
 */
export function parseShipping(delivery: string | undefined): number | null {
	if (!delivery) return null;
	const text = delivery.toLowerCase();
	// Free *shipping/delivery* → $0, but only when it's unconditional. A threshold
	// like "Free delivery on $50+" carries a $ amount that ISN'T a shipping cost,
	// and the real cost below the threshold is unknown → null.
	if (/free\s+(?:delivery|shipping)/.test(text)) {
		return /\$\s*[0-9]/.test(text) ? null : 0;
	}
	const dollars = text.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
	if (dollars) return Number.parseFloat(dollars[1]);
	return null;
}

interface ShoppingResult {
	source?: string;
	title?: string;
	link?: string;
	product_link?: string;
	product_id?: string;
	serpapi_immersive_product_api?: string;
	extracted_price?: number;
	delivery?: string;
}

/** Only allow http(s) links — never let a javascript:/data: URL reach an email href. */
function isSafeHttpUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/**
 * Normalize raw Google Shopping rows into vinyl offers ranked cheapest-first.
 * Rows are kept only when the title is a vinyl pressing of the searched album
 * (isVinylTitle + matchesAlbum). Offers whose seller didn't state shipping have
 * an *unknown* total, so they rank after every known all-in total (then by item
 * price among themselves). Pure + exported for testing.
 */
export function toOffers(
	results: Array<ShoppingResult>,
	title: string,
): Array<SellerOffer> {
	const tokens = albumTokens(title);
	return results
		.filter(
			(r) => typeof r.extracted_price === "number" && r.extracted_price > 0,
		)
		.filter(
			(r) => isVinylTitle(r.title ?? "") && matchesAlbum(r.title ?? "", tokens),
		)
		.map((r) => {
			const itemPrice = r.extracted_price as number;
			const shippingPrice = parseShipping(r.delivery);
			const url = r.product_link || r.link || "";
			return {
				seller: (r.source ?? "").trim() || "Unknown seller",
				url: isSafeHttpUrl(url) ? url : "",
				itemPrice,
				shippingPrice,
				totalPrice: itemPrice + (shippingPrice ?? 0),
				freeShipping: shippingPrice === 0,
				immersiveApi: r.serpapi_immersive_product_api,
				productId: r.product_id,
			} satisfies SellerOffer;
		})
		.filter((o) => o.url)
		.sort((a, b) => {
			const aKnown = a.shippingPrice !== null;
			const bKnown = b.shippingPrice !== null;
			if (aKnown !== bKnown) return aKnown ? -1 : 1; // known totals first
			return a.totalPrice - b.totalPrice;
		});
}

/** Append the API key to a SerpApi-provided endpoint URL (e.g. the immersive link). */
function withApiKey(rawUrl: string): string {
	const url = new URL(rawUrl);
	url.searchParams.set("api_key", env.SERPAPI_KEY as string);
	return url.toString();
}

/**
 * Fetch + cache a SerpApi response and extract the rows we care about. Cache key
 * deliberately excludes the API key so it survives key rotation and never leaks
 * the secret into the cache namespace. Returns [] on any non-OK / parse issue.
 */
async function cachedRows<T>(
	cacheKeyUrl: string,
	requestUrl: string,
	extract: (data: unknown) => Array<T>,
): Promise<Array<T>> {
	try {
		const cache = (caches as unknown as { default: Cache }).default;
		const cacheKey = new Request(cacheKeyUrl);
		// A corrupt cache entry must not poison the lookup — fall through to a
		// fresh fetch rather than throwing out of the whole price block.
		const cached = await cache.match(cacheKey);
		if (cached) {
			const hit = await cached.json().catch(() => null);
			if (Array.isArray(hit)) return hit as Array<T>;
		}

		const res = await fetch(requestUrl);
		if (!res.ok) return [];
		// Invalid JSON or an unexpected shape (extract throwing) → treat as "no
		// rows", same as an empty result. Never let it bubble to the caller.
		const rows = extract(await res.json()).slice(0, MAX_OFFERS);
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
	} catch {
		return [];
	}
}

/** Build the Google Shopping request URL. Bias the query toward vinyl pressings. */
function buildShoppingUrl(artist: string, title: string): string {
	const url = new URL(ENDPOINT);
	url.searchParams.set("engine", "google_shopping");
	url.searchParams.set("q", `${artist} ${title} vinyl record`);
	url.searchParams.set("gl", "us"); // US store → USD, US shipping (Prime context)
	url.searchParams.set("hl", "en");
	url.searchParams.set("api_key", env.SERPAPI_KEY as string);
	return url.toString();
}

interface ImmersiveStore {
	name?: string;
	extracted_price?: number;
	shipping_extracted?: number;
	extracted_total?: number;
}

/**
 * Look up exact per-seller shipping for the chosen offer via the immersive
 * product endpoint SerpApi already handed us, and fold it into the offer in
 * place. Best-effort: on any miss the offer keeps its delivery-string estimate.
 */
async function refineShipping(offer: SellerOffer): Promise<void> {
	if (!offer.immersiveApi) return;
	const stores = await cachedRows<ImmersiveStore>(
		`https://serpapi-immersive/${encodeURIComponent(offer.productId ?? offer.immersiveApi)}`,
		withApiKey(offer.immersiveApi),
		(data) =>
			(data as { product_results?: { stores?: Array<ImmersiveStore> } })
				.product_results?.stores ?? [],
	);

	const target = normalizeText(offer.seller);
	const match = stores.find((s) => {
		const name = normalizeText(s.name ?? "");
		const nameHit =
			Boolean(name) && (name.includes(target) || target.includes(name));
		const priceHit =
			typeof s.extracted_price === "number" &&
			Math.abs(s.extracted_price - offer.itemPrice) <= 1;
		return nameHit || priceHit;
	});
	if (!match) return;

	if (typeof match.shipping_extracted === "number") {
		// Exact shipping known (0 = free).
		offer.shippingPrice = match.shipping_extracted;
		offer.totalPrice = offer.itemPrice + match.shipping_extracted;
		offer.freeShipping = match.shipping_extracted === 0;
	} else if (
		typeof match.extracted_total === "number" &&
		match.extracted_total > offer.itemPrice + 0.001
	) {
		// Shipping wasn't itemised, but the total exceeds the item price, so the
		// difference is real added shipping. (A total *equal* to the item price is
		// ambiguous — free or just unknown — so we leave the estimate untouched.)
		offer.totalPrice = match.extracted_total;
		offer.shippingPrice = match.extracted_total - offer.itemPrice;
		offer.freeShipping = false;
	}
}

interface AmazonResult {
	asin?: string;
	title?: string;
	link?: string;
	link_clean?: string;
	extracted_price?: number;
	prime?: boolean;
	shipping?: string;
	delivery?: Array<string>;
}

/** Build the Amazon search request URL (US store, vinyl-biased keyword). */
function buildAmazonUrl(artist: string, title: string): string {
	const url = new URL(ENDPOINT);
	url.searchParams.set("engine", "amazon");
	url.searchParams.set("k", `${artist} ${title} vinyl`);
	url.searchParams.set("amazon_domain", "amazon.com");
	url.searchParams.set("api_key", env.SERPAPI_KEY as string);
	return url.toString();
}

/**
 * Whether an Amazon row is Prime-eligible. The documented `prime` boolean comes
 * back null in practice, so we fall back to the only reliable signal: Prime free
 * delivery wording in the `delivery`/`shipping` text (e.g. "Join Prime to get
 * FREE delivery…"). "Currently unavailable." items have no such wording.
 */
function isPrimeEligible(result: AmazonResult): boolean {
	if (result.prime === true) return true;
	const text =
		`${result.shipping ?? ""} ${(result.delivery ?? []).join(" ")}`.toLowerCase();
	return /prime/.test(text) && /free\s+(?:delivery|shipping)/.test(text);
}

/**
 * Cheapest Prime-eligible vinyl pressing of the album on Amazon, or null. Same
 * vinyl/relevance filter as the cross-seller search so we never surface the
 * wrong release. Prime members get free delivery, so we price these all-in at
 * the item price (the "$35" thresholds in the delivery text are not a shipping
 * cost we should charge a Prime member).
 */
async function findAmazonPrime(
	artist: string,
	title: string,
): Promise<SellerOffer | null> {
	const results = await cachedRows<AmazonResult>(
		`https://serpapi-amazon/${encodeURIComponent(`${artist}|${title}`)}`,
		buildAmazonUrl(artist, title),
		(data) =>
			(data as { organic_results?: Array<AmazonResult> }).organic_results ?? [],
	);

	const tokens = albumTokens(title);
	const offers = results
		.filter(isPrimeEligible)
		.filter(
			(r) => typeof r.extracted_price === "number" && r.extracted_price > 0,
		)
		.filter(
			(r) => isVinylTitle(r.title ?? "") && matchesAlbum(r.title ?? "", tokens),
		)
		.map((r) => {
			const itemPrice = r.extracted_price as number;
			const url = r.link_clean || r.link || "";
			return {
				seller: "Amazon",
				url: isSafeHttpUrl(url) ? url : "",
				itemPrice,
				shippingPrice: 0, // Prime → free delivery
				totalPrice: itemPrice,
				freeShipping: true,
			} satisfies SellerOffer;
		})
		.filter((o) => o.url)
		.sort((a, b) => a.totalPrice - b.totalPrice);

	return offers[0] ?? null;
}

// Plaid Room Records (plaidroomrecords.com) — a preferred independent shop. It
// runs on Shopify, which exposes a keyless predictive-search JSON endpoint, so
// this lookup hits the store directly rather than going through SerpApi.
const PLAID_ROOM_ORIGIN = "https://www.plaidroomrecords.com";

export interface PlaidRoomProduct {
	title?: string;
	url?: string; // store-relative, e.g. "/products/handle?..." (sometimes absolute)
	price?: string | number;
	available?: boolean;
}

/** Build the Shopify predictive-search request for the album (product results only). */
function buildPlaidRoomUrl(artist: string, title: string): string {
	const url = new URL(`${PLAID_ROOM_ORIGIN}/search/suggest.json`);
	url.searchParams.set("q", `${artist} ${title}`);
	url.searchParams.set("resources[type]", "product");
	url.searchParams.set("resources[limit]", "10");
	return url.toString();
}

/**
 * Coerce a Shopify predictive-search price into USD. The field comes back as
 * either a formatted string ("$25.00") or a number that may be dollars (25) or
 * cents (2500). Cents values are always whole numbers, and a vinyl LP costing
 * four figures is implausible, so a *whole* value ≥ 1000 is read as cents and
 * folded back to dollars (a fractional total like 1234.50 is left alone).
 * Returns null for a missing/zero/unparseable price. Pure + exported for testing.
 */
export function parsePlaidRoomPrice(
	raw: string | number | undefined,
): number | null {
	let value: number | null = null;
	if (typeof raw === "number") value = raw;
	else if (typeof raw === "string") {
		const digits = raw.replace(/[^0-9.]/g, "");
		if (digits) value = Number.parseFloat(digits);
	}
	if (value === null || !Number.isFinite(value) || value <= 0) return null;
	return Number.isInteger(value) && value >= 1000 ? value / 100 : value;
}

/**
 * Normalize Plaid Room predictive-search products into vinyl offers for the album,
 * cheapest first. Store-relative urls are resolved against the store origin, and
 * the same vinyl/relevance filter as the cross-seller search keeps us on the right
 * release — matched on artist + title, since a store-wide search is fuzzier than a
 * per-album Google query. Shipping isn't returned, so offers carry an unknown
 * shipping cost (priced at item price). Pure + exported for testing.
 */
export function toPlaidRoomOffers(
	products: Array<PlaidRoomProduct>,
	artist: string,
	title: string,
): Array<SellerOffer> {
	const tokens = albumTokens(`${artist} ${title}`);
	return products
		.filter((p) => p.available !== false)
		.map((p) => {
			const path = (p.url ?? "").trim();
			const url = path
				? isSafeHttpUrl(path)
					? path
					: `${PLAID_ROOM_ORIGIN}${path}`
				: "";
			return {
				title: p.title ?? "",
				itemPrice: parsePlaidRoomPrice(p.price),
				url,
			};
		})
		.filter(
			(o): o is { title: string; itemPrice: number; url: string } =>
				o.itemPrice !== null && isSafeHttpUrl(o.url),
		)
		.filter((o) => isVinylTitle(o.title) && matchesAlbum(o.title, tokens))
		.map(
			(o) =>
				({
					seller: "Plaid Room Records",
					url: o.url,
					itemPrice: o.itemPrice,
					shippingPrice: null, // predictive search doesn't state shipping
					totalPrice: o.itemPrice,
					freeShipping: false,
				}) satisfies SellerOffer,
		)
		.sort((a, b) => a.totalPrice - b.totalPrice);
}

/** Cheapest in-stock vinyl match for the album at Plaid Room Records, or null. */
async function findPlaidRoom(
	artist: string,
	title: string,
): Promise<SellerOffer | null> {
	const products = await cachedRows<PlaidRoomProduct>(
		`https://plaidroom-search/${encodeURIComponent(`${artist}|${title}`)}`,
		buildPlaidRoomUrl(artist, title),
		(data) =>
			(
				data as {
					resources?: { results?: { products?: Array<PlaidRoomProduct> } };
				}
			).resources?.results?.products ?? [],
	);
	return toPlaidRoomOffers(products, artist, title)[0] ?? null;
}

/**
 * Find the cheapest place to buy a record on vinyl, by total cost incl. shipping,
 * plus an Amazon Prime option and a Plaid Room Records option when they exist.
 * Returns null when pricing is unavailable (no key, no qualifying vinyl offer, or
 * any error on the primary lookup). The shipping-refine, Prime and Plaid Room
 * lookups are independently best-effort.
 */
export async function findCheapestVinyl(
	artist: string,
	title: string,
): Promise<SellerSummary | null> {
	if (!env.SERPAPI_KEY) return null;
	try {
		const results = await cachedRows<ShoppingResult>(
			`https://serpapi-cache/${encodeURIComponent(`${artist}|${title}`)}`,
			buildShoppingUrl(artist, title),
			(data) =>
				(data as { shopping_results?: Array<ShoppingResult> })
					.shopping_results ?? [],
		);

		const offers = toOffers(results, title);
		if (offers.length === 0) return null;
		const cheapest = offers[0];

		// Exact shipping for the chosen offer is a best-effort enrichment; the
		// Prime and Plaid Room options are independent best-effort lookups. A
		// failure in any of them must not drop the line (or the other lookups).
		await refineShipping(cheapest).catch(() => {});
		let [prime, plaidRoom] = await Promise.all([
			findAmazonPrime(artist, title).catch(() => null),
			findPlaidRoom(artist, title).catch(() => null),
		]);
		// Don't echo the exact same listing as both the cheapest and a named line.
		if (prime && prime.url === cheapest.url) prime = null;
		if (plaidRoom && plaidRoom.url === cheapest.url) plaidRoom = null;

		return { cheapest, offerCount: offers.length, prime, plaidRoom };
	} catch {
		return null;
	}
}
