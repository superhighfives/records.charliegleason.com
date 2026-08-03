import { runClaude } from "#/lib/ai";
import { parseBarcode } from "#/lib/discogs-shared";

/**
 * Turn an Amazon ASIN into the release facts we can match against Discogs. The
 * ASIN itself isn't in Discogs, so this reads the public product page (via
 * Claude's server-side web_search) and pulls out the fields that actually pin a
 * pressing — barcode above all, then year/label/catno/disc-count/size — plus the
 * artist/title for a keyword fallback. Server-only (imports `#/lib/ai`, which
 * pulls in `cloudflare:workers`); call it through the `identifyAsin` server fn.
 *
 * See analyze.ts `identifyWithWebSearch` for the same web_search loop shape; this
 * is the ASIN-input sibling of that cover-photo path.
 */

/** What we could learn about an Amazon product, for matching to a Discogs release. */
export interface AsinIdentity {
	artist: string;
	title: string;
	year: number | null; // this product's (reissue) year — what distinguishes pressings
	label: string | null;
	catno: string | null; // label catalog number, NOT Amazon's item-model-number SKU
	barcode: string | null; // UPC/EAN — the exact-pressing key, when the page shows it
	country: string | null;
	discCount: number | null;
	size: string | null; // vinyl size, e.g. '12"'
	format: string | null; // LP / EP / Single
	confidence: number; // 0–1 in artist + title
}

const PRODUCT_TOOL = {
	name: "product",
	description:
		"Report the music release identified from an Amazon product page.",
	input_schema: {
		type: "object" as const,
		properties: {
			artist: { type: "string" },
			title: { type: "string", description: "Album/release title" },
			year: {
				type: ["integer", "null"],
				description:
					"The year of THIS product/pressing (a reissue year if it's a reissue), which is what distinguishes one pressing from another. Null if not shown.",
			},
			label: {
				type: ["string", "null"],
				description: "Record label, if shown",
			},
			catno: {
				type: ["string", "null"],
				description:
					"The record label's catalog number, ONLY if clearly shown as such. Do NOT use Amazon's 'Item model number' — that's usually Amazon's own SKU, not a catalog number.",
			},
			barcode: {
				type: ["string", "null"],
				description:
					"The UPC or EAN barcode (12–13 digits), if the page shows one. This is the most valuable field — include it whenever available.",
			},
			country: {
				type: ["string", "null"],
				description: "Pressing country, if determinable. Null if unclear.",
			},
			discCount: {
				type: ["integer", "null"],
				description: "Number of discs/LPs (e.g. 'Number of discs: 2').",
			},
			size: {
				type: ["string", "null"],
				description: 'Vinyl size such as 12", 10", or 7". Null if unknown.',
			},
			format: {
				type: ["string", "null"],
				description: "Release type: LP, EP, or Single.",
			},
			confidence: {
				type: "number",
				description: "0–1 confidence in the artist + title.",
			},
		},
		required: ["artist", "title", "confidence"],
	},
};

/** Coerce the model's tool input into a validated {@link AsinIdentity}. */
function shapeIdentity(input: Partial<AsinIdentity>): AsinIdentity {
	const barcode =
		typeof input.barcode === "string" ? parseBarcode(input.barcode) : null;
	const discCount =
		typeof input.discCount === "number" && input.discCount > 0
			? Math.floor(input.discCount)
			: null;
	return {
		artist: String(input.artist ?? "").trim(),
		title: String(input.title ?? "").trim(),
		year: typeof input.year === "number" ? input.year : null,
		label: input.label ? String(input.label).trim() : null,
		catno: input.catno ? String(input.catno).trim() : null,
		barcode,
		country: input.country ? String(input.country).trim() : null,
		discCount,
		size: input.size ? String(input.size).trim() : null,
		format: input.format ? String(input.format).trim() : null,
		confidence: typeof input.confidence === "number" ? input.confidence : 0,
	};
}

/**
 * Resolve an ASIN to release facts via web_search. Returns null when web_search
 * isn't available on the AI path or the model never reports a product (so callers
 * can degrade to a plain keyword search). Never throws — mirrors
 * `identifyWithWebSearch`'s self-contained, best-effort contract.
 */
export async function identifyFromAsin(
	asin: string,
): Promise<AsinIdentity | null> {
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous Anthropic message content
	const messages: Array<any> = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: `Amazon ASIN "${asin}" is a music release (vinyl record or CD). Use web search to find its Amazon product page — the ASIN may be from any Amazon marketplace, so try the US and UK sites (amazon.com/dp/${asin}, amazon.co.uk/dp/${asin}) and any corroborating source (Discogs, MusicBrainz). Then report the artist, album title, and the pressing details that distinguish one edition from another — the barcode (UPC/EAN) above all, plus the label, catalog number, year, pressing country, number of discs, vinyl size and format. When you have it, call the "product" tool.`,
				},
			],
		},
	];

	try {
		// Same rationale as analyze.ts: this is turn *resumption*, not retries. A
		// single call lets web_search run several times; iterate only to continue a
		// paused turn. 2 passes is plenty.
		for (let i = 0; i < 2; i++) {
			const r = await runClaude({
				max_tokens: 2048,
				tools: [
					{
						type: "web_search_20260209",
						name: "web_search",
						max_uses: 3,
					},
					PRODUCT_TOOL,
				],
				messages,
			});

			const usedWebSearch = r.content.some(
				(b) =>
					b.type === "server_tool_use" || b.type === "web_search_tool_result",
			);
			console.info(
				`[asin] web-search iter ${i}: web_search ${
					usedWebSearch ? "RAN" : "did not run"
				} · blocks=[${r.content.map((b) => b.type).join(",")}]`,
			);

			const prod = r.content.find(
				(b) => b.type === "tool_use" && b.name === "product",
			) as { input?: unknown } | undefined;
			if (prod?.input) {
				return shapeIdentity(prod.input as Partial<AsinIdentity>);
			}

			if (r.stop_reason === "end_turn") break;
			messages.push({ role: "assistant", content: r.content });
		}
		return null;
	} catch (err) {
		console.warn(
			`[asin] web-search identify failed (likely unsupported on env.AI.run): ${String(err)}`,
		);
		return null;
	}
}
