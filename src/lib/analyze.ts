import { env } from "cloudflare:workers";

import type { Record } from "#/db/schema";
import { runClaude } from "#/lib/ai";
import {
	type DiscogsCandidate,
	getReleaseDetail,
	searchReleases,
} from "#/lib/discogs";
import { bytesToBase64 } from "#/lib/image-data";
import { sourceCoverFromDiscogs } from "#/lib/images";
import { getPitchforkScore } from "#/lib/the-fork";

/**
 * Server-only record analysis pipeline. Reads a stored capture photo, identifies
 * the release (Claude vision → Discogs → web-search escalation), scores it on
 * Pitchfork and sources a cover. Runs in the queue consumer — never import this
 * from a client route (it pulls in `cloudflare:workers`); use the `searchDiscogs`
 * server fn in `lib/records.ts` for the UI's manual lookup instead.
 */

/**
 * The enrichment the background analysis produces for a captured record. The
 * queue consumer writes this onto the row and moves it to `review`.
 */
export interface AnalysisResult {
	artist: string;
	title: string;
	year: number | null;
	label: string | null;
	format: string | null; // release type — LP / EP / Single (from Discogs)
	size: string | null; // physical size — e.g. '12"' (from Discogs)
	catno: string | null; // catalog number (from Discogs)
	country: string | null; // pressing country (from Discogs)
	genre: string | null;
	pitchforkScore: number | null;
	pitchforkUrl: string | null;
	discogsId: string | null;
	discogsUrl: string | null;
	coverImageKey: string | null;
	confidence: number;
	candidates: Array<DiscogsCandidate>;
}

interface Extraction {
	artist: string;
	title: string;
	year: number | null;
	confidence: number;
}

/**
 * Normalize a name for loose comparison: fold diacritics to their base letter
 * (ö → o, so "Björk" matches a plain "Bjork"), lowercase, then collapse runs of
 * punctuation/whitespace to single spaces.
 */
function normalizeName(value: string | null | undefined): string {
	return (value ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "") // drop combining marks left by NFKD
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * Decide whether an identified record already exists in the collection. Matches
 * on Discogs id first (the most reliable signal — same release), then falls back
 * to a normalized artist + title comparison so a re-photographed sleeve still
 * gets flagged even when Discogs didn't resolve. Returns the id of the existing
 * record it duplicates, or null. Pure: the caller supplies the rows to check
 * against (the record being analyzed must be excluded by the caller).
 */
export function findDuplicateOf(
	target: { artist: string; title: string; discogsId: string | null },
	existing: Array<Pick<Record, "id" | "artist" | "title" | "discogsId">>,
): number | null {
	const artist = normalizeName(target.artist);
	const title = normalizeName(target.title);
	const discogsId = target.discogsId?.trim() || null;

	// A blank identification can't meaningfully match anything.
	if (!discogsId && (!artist || !title)) return null;

	// The caller's rows are unordered, so track the smallest id in each bucket to
	// keep the result deterministic and point at the earliest record. A Discogs id
	// match (same release) outranks a name-only match regardless of id.
	let discogsMatch: number | null = null;
	let nameMatch: number | null = null;
	for (const row of existing) {
		if (discogsId && row.discogsId?.trim() === discogsId) {
			if (discogsMatch === null || row.id < discogsMatch) discogsMatch = row.id;
			continue;
		}
		if (
			artist &&
			title &&
			normalizeName(row.artist) === artist &&
			normalizeName(row.title) === title
		) {
			if (nameMatch === null || row.id < nameMatch) nameMatch = row.id;
		}
	}
	return discogsMatch ?? nameMatch;
}

const EXTRACT_TOOL = {
	name: "record",
	description: "Report the identified vinyl record.",
	input_schema: {
		type: "object" as const,
		properties: {
			artist: { type: "string" },
			title: { type: "string", description: "Album/release title" },
			year: {
				type: ["integer", "null"],
				description: "Release year if visible",
			},
			confidence: {
				type: "number",
				description: "0–1 confidence in artist + title",
			},
		},
		required: ["artist", "title", "confidence"],
	},
};

/** Read artist/title/year off the cover with Claude vision (forced tool call). */
async function extractFromImage(
	data: string,
	mediaType: string,
	context?: string,
): Promise<Extraction> {
	const instruction =
		"Identify the vinyl record from this cover photo. If the artist and album title are printed on the cover, read them exactly as printed. If the cover has little or no text — abstract or image-only artwork, which is common for iconic albums — identify the release by recognising the artwork itself. Only set a year if it's clearly shown, and report confidence honestly: low if you're unsure or guessing.";
	const text = context
		? `${instruction}\n\nExtra context from the collector (use it to disambiguate the pressing/format or guide the read): ${context}`
		: instruction;

	const msg = await runClaude({
		max_tokens: 1024,
		tools: [EXTRACT_TOOL],
		tool_choice: { type: "tool", name: "record" },
		messages: [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: mediaType, data },
					},
					{
						type: "text",
						text,
					},
				],
			},
		],
	});

	const block = msg.content.find((b) => b.type === "tool_use") as
		| { input?: unknown }
		| undefined;
	const input = (block?.input ?? {}) as Partial<Extraction>;
	return {
		artist: String(input.artist ?? "").trim(),
		title: String(input.title ?? "").trim(),
		year: typeof input.year === "number" ? input.year : null,
		confidence: typeof input.confidence === "number" ? input.confidence : 0,
	};
}

/**
 * Escalation: let Claude use the server-side web_search tool to pin down a
 * record the cover read + Discogs couldn't. Bounded manual loop; returns a
 * refined extraction or null. Self-contained: never throws, logs whether
 * web_search actually ran so we can confirm support on the env.AI.run path.
 */
async function identifyWithWebSearch(
	partial: Extraction,
	image: { data: string; mediaType: string },
	context?: string,
): Promise<Extraction | null> {
	const hint = context ? ` The collector adds: "${context}".` : "";
	const guess =
		partial.artist || partial.title
			? `A first guess from reading the cover is artist="${partial.artist}", title="${partial.title}", but it may be wrong or incomplete.`
			: "Reading the cover text alone wasn't enough — it has little or no printed text.";
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous Anthropic message content
	const messages: Array<any> = [
		{
			role: "user",
			content: [
				{
					type: "image",
					source: {
						type: "base64",
						media_type: image.mediaType,
						data: image.data,
					},
				},
				{
					type: "text",
					text: `I photographed this vinyl record cover. ${guess}${hint} Recognise the album from the cover artwork — many iconic records have abstract, text-free sleeves — and use web search to confirm the correct artist, album title, and original release year (check Discogs/Wikipedia). When confident, call the "record" tool with the corrected values.`,
				},
			],
		},
	];

	// Did Anthropic's server-side web_search actually run on this AI path? Logged
	// so the first real capture tells us whether web_search rides through Unified
	// Billing (env.AI.run), without needing a curl pre-flight.
	try {
		// This loop is turn *resumption*, not retries: a single call already lets
		// web_search run several times internally, and once Claude ends its turn
		// without a `record` call we break (re-asking wouldn't help). The only reason
		// to iterate is to continue a paused/truncated turn — so 2 (turn + one
		// continuation) is plenty. Each pass re-sends the image + growing history, and
		// web_search injects fetched page content as input tokens, so extra iterations
		// are the most expensive thing in the whole pipeline. Don't raise this.
		for (let i = 0; i < 2; i++) {
			const r = await runClaude({
				max_tokens: 2048,
				tools: [
					{
						type: "web_search_20260209",
						name: "web_search",
						// Cap searches per turn — the injected page content dominates the
						// token cost (a single escalation can hit ~48k input tokens).
						max_uses: 3,
					},
					EXTRACT_TOOL,
				],
				messages,
			});

			const usedWebSearch = r.content.some(
				(b) =>
					b.type === "server_tool_use" || b.type === "web_search_tool_result",
			);
			console.info(
				`[analyze] web-search iter ${i}: web_search ${
					usedWebSearch ? "RAN" : "did not run"
				} · blocks=[${r.content.map((b) => b.type).join(",")}]`,
			);

			const rec = r.content.find(
				(b) => b.type === "tool_use" && b.name === "record",
			) as { input?: unknown } | undefined;
			if (rec?.input) {
				const input = rec.input as Partial<Extraction>;
				return {
					artist: String(input.artist ?? partial.artist).trim(),
					title: String(input.title ?? partial.title).trim(),
					year: typeof input.year === "number" ? input.year : partial.year,
					confidence:
						typeof input.confidence === "number" ? input.confidence : 0.7,
				};
			}

			if (r.stop_reason === "end_turn") break;
			messages.push({ role: "assistant", content: r.content });
		}
		return null;
	} catch (err) {
		// Most likely the AI path rejected the web_search tool — degrade to Discogs.
		console.warn(
			`[analyze] web-search escalation failed (likely unsupported on env.AI.run): ${String(err)}`,
		);
		return null;
	}
}

/**
 * The full background pipeline for one captured record: read the stored capture
 * photo from R2, identify it (vision → Discogs → web-search escalation), score it
 * on Pitchfork, and source a resized cover. Never stores anything on the record —
 * the queue consumer writes the result.
 */
export async function analyzeCapture(record: Record): Promise<AnalysisResult> {
	if (!record.capturePhotoKey) {
		throw new Error("record has no capture photo to analyze");
	}

	const object = await env.PHOTOS.get(record.capturePhotoKey);
	if (!object) {
		throw new Error(`capture photo missing in R2: ${record.capturePhotoKey}`);
	}
	const bytes = new Uint8Array(await object.arrayBuffer());
	const data = bytesToBase64(bytes);
	const mediaType = object.httpMetadata?.contentType || "image/jpeg";
	const context = record.captureContext?.trim() || undefined;

	// 1. Vision read.
	let extraction = await extractFromImage(data, mediaType, context);

	// 2. Discogs lookup.
	let candidates = extraction.artist
		? await searchReleases({
				artist: extraction.artist,
				title: extraction.title,
				country: "",
				year: "",
				q: "",
			}).catch(() => [])
		: [];

	// 3. Escalate to web search when unsure or unmatched.
	if (extraction.confidence < 0.3 || candidates.length === 0) {
		console.info(
			`[analyze] escalating to web search (confidence=${extraction.confidence}, discogs matches=${candidates.length})`,
		);
		const refined = await identifyWithWebSearch(
			extraction,
			{ data, mediaType },
			context,
		);
		if (refined) {
			extraction = refined;
			candidates = await searchReleases({
				artist: refined.artist,
				title: refined.title,
				country: "",
				year: "",
				q: "",
			}).catch(() => []);
		}
	}

	const best = candidates[0] ?? null;

	// Search hits carry unreliable enrichment fields — Discogs' search `format`
	// array often omits the size and the size-less 12" LP case can't be inferred
	// from it. Pull the full release so the enrichment matches the refresh path
	// (getReleaseDetail), falling back to the search hit if the fetch fails.
	const detail = best?.discogsId
		? await getReleaseDetail(best.discogsId).catch(() => null)
		: null;

	// 4. Pitchfork score (best-effort).
	const pitchfork = await getPitchforkScore(
		extraction.artist,
		extraction.title,
	);

	// 5. Source + resize the displayed cover from the best Discogs match.
	const coverImageKey = best?.discogsId
		? await sourceCoverFromDiscogs(best.discogsId)
		: null;

	return {
		artist: detail?.artist || best?.artist || extraction.artist,
		title: detail?.title || best?.title || extraction.title,
		year: detail?.year ?? best?.year ?? extraction.year,
		label: detail?.label ?? best?.label ?? null,
		format: detail?.type ?? best?.type ?? null,
		size: detail?.size ?? best?.size ?? null,
		catno: detail?.catno ?? best?.catno ?? null,
		country: detail?.country ?? best?.country ?? null,
		genre: detail?.genre ?? best?.genre ?? null,
		pitchforkScore: pitchfork?.score ?? null,
		pitchforkUrl: pitchfork?.url ?? null,
		discogsId: best?.discogsId ?? null,
		discogsUrl: best?.discogsUrl ?? null,
		coverImageKey,
		confidence: extraction.confidence,
		candidates,
	};
}
