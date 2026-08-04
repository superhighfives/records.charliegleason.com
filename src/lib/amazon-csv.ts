import type { Record } from "#/db/schema";
import { parseAsin } from "#/lib/discogs-shared";
import { foldDiacritics } from "#/lib/records-path";

/**
 * Parse an Amazon "Request My Data" order-history export (Retail.OrderHistory.csv)
 * into the music items we can match to Discogs, and fuzzily line those up against
 * the collection's unmatched records. Pure + browser-safe (no
 * `cloudflare:workers`), so the import dialog can parse the file client-side. The
 * ASIN itself isn't in Discogs — the importer resolves each one via the shared
 * `identifyAsin` path — this module only turns the CSV into {asin, title} rows and
 * guesses which unmatched record each purchase belongs to.
 */

/** One music purchase pulled from the Amazon order-history CSV. */
export interface AmazonItem {
	asin: string;
	title: string;
	category: string | null;
	orderDate: string | null;
	// The pressing country implied by the marketplace you bought from (Amazon.co.uk
	// → "UK"), as a Discogs-style country name, or null if unknown. A regional
	// marketplace strongly implies the regional pressing — the fast disambiguator
	// between otherwise-identical pressings — so we carry it through to matching.
	country: string | null;
}

// Map an Amazon marketplace domain (the export's `Website` column) to the Discogs
// country name for the pressing it most likely sold. Only the marketplaces worth
// distinguishing; anything else is left null (no country hint).
const MARKETPLACE_COUNTRY: { [domain: string]: string } = {
	"amazon.co.uk": "UK",
	"amazon.com": "US",
	"amazon.ca": "Canada",
	"amazon.de": "Germany",
	"amazon.fr": "France",
	"amazon.it": "Italy",
	"amazon.es": "Spain",
	"amazon.nl": "Netherlands",
	"amazon.co.jp": "Japan",
	"amazon.com.au": "Australia",
};

/** Discogs-style country name for an Amazon marketplace domain, or null. */
export function marketplaceCountry(website: string | null): string | null {
	if (!website) return null;
	return MARKETPLACE_COUNTRY[website.trim().toLowerCase()] ?? null;
}

/**
 * A best-effort product-image URL for an ASIN, off Amazon's public media CDN
 * (`/images/P/{ASIN}.01._SL{size}_.jpg`). Undocumented but stable, and the same
 * image across marketplaces — so a UK ASIN resolves too. Not every ASIN has an
 * image (some 404); render it with an `onError` fallback. `size` scales the
 * longest side, in px.
 */
export function amazonImageUrl(asin: string, size = 160): string {
	return `https://m.media-amazon.com/images/P/${asin}.01._SL${size}_.jpg`;
}

/**
 * Split RFC 4180-ish CSV text into rows of fields — handles quoted fields with
 * embedded commas, newlines, and doubled `""` escapes (all of which Amazon's
 * export uses in product titles). Tolerates both `\r\n` and `\n` line endings.
 */
export function parseCsv(text: string): Array<Array<string>> {
	const rows: Array<Array<string>> = [];
	let field = "";
	let row: Array<string> = [];
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (ch !== "\r") {
			field += ch;
		}
	}
	// Flush a trailing field/row that wasn't terminated by a newline.
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/**
 * Is this Amazon category (from the export's `Category` column) music? Amazon tags
 * physical music as `ABIS_MUSIC`; other media are `ABIS_BOOK`, `DOWNLOADABLE_*`,
 * etc. A null/absent category means the export didn't include the column — keep the
 * row (the ASIN filter + the later Discogs lookup still guard against non-music).
 */
function isMusicCategory(category: string | null): boolean {
	if (!category) return true;
	return /music|vinyl|abis_music/i.test(category);
}

/** Case-insensitive column locator: first header equal to, or containing, a name. */
function findColumn(header: Array<string>, names: Array<string>): number {
	const exact = header.findIndex((h) => names.includes(h));
	if (exact >= 0) return exact;
	return header.findIndex((h) => names.some((n) => h.includes(n)));
}

/**
 * Parse the order-history CSV into deduped music {@link AmazonItem}s. Keeps only
 * rows with a physical-product ASIN (a B-prefixed code — books/digital are
 * filtered out) in a music category, deduped by ASIN (people re-buy). Returns []
 * when the file doesn't look like an order history (missing ASIN/Title columns).
 */
export function parseAmazonOrderHistory(csv: string): Array<AmazonItem> {
	const rows = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ""));
	if (rows.length < 2) return [];

	const header = rows[0].map((h) => h.trim().toLowerCase());
	const asinCol = findColumn(header, ["asin", "asin/isbn"]);
	const titleCol = findColumn(header, ["title", "product name", "name"]);
	const catCol = findColumn(header, ["category"]);
	const dateCol = findColumn(header, ["order date", "date"]);
	const siteCol = findColumn(header, ["website"]);
	if (asinCol < 0 || titleCol < 0) return [];

	const seen = new Set<string>();
	const items: Array<AmazonItem> = [];
	for (const r of rows.slice(1)) {
		const asin = parseAsin(r[asinCol] ?? "");
		if (!asin || seen.has(asin)) continue;
		const category = catCol >= 0 ? r[catCol]?.trim() || null : null;
		if (!isMusicCategory(category)) continue;
		const title = (r[titleCol] ?? "").trim();
		if (!title) continue;
		seen.add(asin);
		items.push({
			asin,
			title,
			category,
			orderDate: dateCol >= 0 ? r[dateCol]?.trim() || null : null,
			country: siteCol >= 0 ? marketplaceCountry(r[siteCol] ?? null) : null,
		});
	}
	return items;
}

// Words that carry no matching signal — format/edition noise common to Amazon
// music titles and generic filler — so a shared "vinyl" doesn't fake a match.
const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"of",
	"vinyl",
	"lp",
	"ep",
	"record",
	"records",
	"album",
	"albums",
	"edition",
	"remastered",
	"remaster",
	"import",
	"cd",
	"deluxe",
	"expanded",
	"anniversary",
	"reissue",
	"explicit",
]);

/** Significant lower-cased tokens of a title, minus bracketed notes + stop words. */
function significantTokens(value: string): Set<string> {
	return new Set(
		foldDiacritics(value)
			.replace(/\[[^\]]*\]/g, " ") // drop "[VINYL]" / "[Explicit]" notes
			.replace(/\([^)]*\)/g, " ") // drop "(Deluxe Edition)" notes
			.replace(/[^a-z0-9]+/g, " ")
			.split(" ")
			.filter((t) => t.length > 1 && !STOP_WORDS.has(t)),
	);
}

/** A collection member the Amazon matcher reads — just the fields it compares. */
export type MatchRecord = Pick<Record, "id" | "artist" | "title">;

// Minimum fraction of the Amazon title's significant tokens that the record
// (artist + title) must explain. Rejects an album whose title is a single common
// word buried in an unrelated product — "Lemonade" ← a lemonade drink, "Version"
// ← a Windows licence — where that one word is a tiny slice of the product name.
const MIN_COVERAGE = 0.4;

/** A record's tokens, split so the matcher can weigh the title separately. */
interface RecordTokens {
	titleTokens: Set<string>;
	recTokens: Set<string>;
}

function recordTokens(r: MatchRecord): RecordTokens {
	return {
		titleTokens: significantTokens(r.title),
		recTokens: significantTokens(`${r.artist} ${r.title}`),
	};
}

/**
 * Score how well an Amazon purchase matches a record, or null for no match. Two
 * gates, tuned against real order-history noise where one shared word is common:
 *  1. An album-TITLE token must appear in the Amazon title — an incidental artist
 *     or generic overlap isn't enough. Stops "Dirty Projectors" matching "Dirty
 *     Computer", "Jeff Wayne … War …" matching "God of War", "David Bowie"
 *     matching "DAVID ARCHY" — there the shared word was the artist, not the album.
 *  2. Coverage ≥ {@link MIN_COVERAGE} — most of the Amazon title's tokens must be
 *     explained by the record, so a one-common-word album title ("Lemonade")
 *     doesn't match a long unrelated product name that happens to contain it.
 *  3. The shared title tokens must be a real chunk of the album title (title
 *     recall high) OR the item must be almost entirely album words (coverage
 *     high). Stops "God of War" matching "Jeff Wayne … War …" on the lone common
 *     word "War", while still allowing an abbreviated long title ("Ziggy Stardust"
 *     ← the full "Rise and Fall of Ziggy Stardust …") and a cruft-laden exact
 *     title ("Bangerz: 10th Anniversary" ← "Bangerz").
 * The score is the coverage, so the greedy pass prefers the tightest fit.
 */
const STRONG_COVERAGE = 0.75;
const MIN_TITLE_RECALL = 0.5;

function scorePurchase(
	itemTokens: Set<string>,
	rt: RecordTokens,
): number | null {
	if (itemTokens.size === 0 || rt.recTokens.size === 0) return null;
	let titleShared = 0;
	for (const t of rt.titleTokens) if (itemTokens.has(t)) titleShared++;
	if (titleShared === 0) return null; // gate 1: the album title must appear
	let covered = 0;
	for (const t of itemTokens) if (rt.recTokens.has(t)) covered++;
	const coverage = covered / itemTokens.size;
	if (coverage < MIN_COVERAGE) return null; // gate 2
	// gate 3: a meaningful slice of the title matched, or the item is ~all album.
	const titleRecall = titleShared / rt.titleTokens.size;
	if (titleRecall < MIN_TITLE_RECALL && coverage < STRONG_COVERAGE) return null;
	return coverage;
}

/**
 * Guess which record an Amazon purchase corresponds to — the best-scoring record
 * that clears both {@link scorePurchase} gates, or null. Pure; the caller supplies
 * the pool (typically records that have a master but no pinned pressing).
 */
export function matchAmazonToRecord(
	item: AmazonItem,
	records: Array<MatchRecord>,
): number | null {
	const itemTokens = significantTokens(item.title);
	let bestId: number | null = null;
	let bestScore = 0;
	for (const r of records) {
		const score = scorePurchase(itemTokens, recordTokens(r));
		if (score != null && score > bestScore) {
			bestScore = score;
			bestId = r.id;
		}
	}
	return bestId;
}

/** A purchase paired with the record it belongs to. */
export interface PurchasePair<R extends MatchRecord> {
	item: AmazonItem;
	record: R;
}

/**
 * Pair purchases to records with a greedy, mutually-exclusive assignment: score
 * every (purchase, record) pair through {@link scorePurchase}, then take them
 * highest-score first, never reusing a purchase or a record. This beats "for each
 * purchase, pick its best record" — which lets one popular record get claimed by
 * several purchases (a live album + a greatest-hits both matching one title) and
 * strands the rest. Records are matched at most once.
 */
export function pairPurchasesToRecords<R extends MatchRecord>(
	items: Array<AmazonItem>,
	records: Array<R>,
): Array<PurchasePair<R>> {
	const recTokens = records.map((record) => ({
		record,
		tokens: recordTokens(record),
	}));

	const scored: Array<{ item: AmazonItem; record: R; score: number }> = [];
	for (const item of items) {
		const itemTokens = significantTokens(item.title);
		if (itemTokens.size === 0) continue;
		for (const { record, tokens } of recTokens) {
			const score = scorePurchase(itemTokens, tokens);
			if (score != null) scored.push({ item, record, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	const usedItems = new Set<string>();
	const usedRecords = new Set<number>();
	const pairs: Array<PurchasePair<R>> = [];
	for (const { item, record } of scored) {
		if (usedItems.has(item.asin) || usedRecords.has(record.id)) continue;
		usedItems.add(item.asin);
		usedRecords.add(record.id);
		pairs.push({ item, record });
	}
	return pairs;
}
