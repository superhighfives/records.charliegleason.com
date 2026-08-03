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

/**
 * Guess which record an Amazon purchase corresponds to, by token overlap between
 * the Amazon title (which usually smushes artist + album together, plus format
 * noise) and each record's `artist title`. Returns the best record id above a
 * confidence floor, or null when nothing's close enough — the importer only ever
 * matches a purchase to a record you already have. Pure; caller supplies the pool
 * (typically the *unmatched* records).
 */
export function matchAmazonToRecord(
	item: AmazonItem,
	records: Array<MatchRecord>,
): number | null {
	const itemTokens = significantTokens(item.title);
	if (itemTokens.size === 0) return null;

	let bestId: number | null = null;
	let bestScore = 0;
	for (const r of records) {
		const recTokens = significantTokens(`${r.artist} ${r.title}`);
		if (recTokens.size === 0) continue;
		let shared = 0;
		for (const t of itemTokens) if (recTokens.has(t)) shared++;
		// Overlap relative to the smaller set, so a short record title fully
		// contained in a long Amazon title still scores high.
		const score = shared / Math.min(itemTokens.size, recTokens.size);
		if (score > bestScore) {
			bestScore = score;
			bestId = r.id;
		}
	}
	return bestScore >= 0.6 ? bestId : null;
}

/** A purchase paired with the record it belongs to. */
export interface PurchasePair<R extends MatchRecord> {
	item: AmazonItem;
	record: R;
}

/**
 * Pair purchases to records with a greedy, mutually-exclusive assignment: score
 * every (purchase, record) pair by title-token overlap, then take them
 * highest-score first, never reusing a purchase or a record. This beats "for each
 * purchase, pick its best record" — which lets one popular record get claimed by
 * several purchases (a live album + a greatest-hits both matching one title) and
 * strands the rest. Threshold is a touch looser than the single-item matcher since
 * each pairing is user-reviewed before it's saved. Records are matched at most
 * once; the caller's pool is typically the *unmatched* records.
 */
export function pairPurchasesToRecords<R extends MatchRecord>(
	items: Array<AmazonItem>,
	records: Array<R>,
	threshold = 0.5,
): Array<PurchasePair<R>> {
	const recTokens = records.map((record) => ({
		record,
		tokens: significantTokens(`${record.artist} ${record.title}`),
	}));

	const scored: Array<{ item: AmazonItem; record: R; score: number }> = [];
	for (const item of items) {
		const itemTokens = significantTokens(item.title);
		if (itemTokens.size === 0) continue;
		for (const { record, tokens } of recTokens) {
			if (tokens.size === 0) continue;
			let shared = 0;
			for (const t of itemTokens) if (tokens.has(t)) shared++;
			const score = shared / Math.min(itemTokens.size, tokens.size);
			if (score >= threshold) scored.push({ item, record, score });
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
