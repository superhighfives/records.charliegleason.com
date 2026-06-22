import { env } from "cloudflare:workers";

import type { Record } from "#/db/schema";
import { runClaude } from "#/lib/ai";
import { type DiscogsCandidate, searchReleases } from "#/lib/discogs";
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
		"Identify the vinyl record from this cover photo. Read the artist and album title exactly as printed. Only set a year if it's clearly shown.";
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
	context?: string,
): Promise<Extraction | null> {
	const hint = context ? ` The collector adds: "${context}".` : "";
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous Anthropic message content
	const messages: Array<any> = [
		{
			role: "user",
			content: `I photographed a vinyl record. A first guess is artist="${partial.artist}", title="${partial.title}".${hint} Use web search to confirm the correct artist, album title, and original release year (check Discogs/Wikipedia). When confident, call the "record" tool with the corrected values.`,
		},
	];

	// Did Anthropic's server-side web_search actually run on this AI path? Logged
	// so the first real capture tells us whether web_search rides through Unified
	// Billing (env.AI.run), without needing a curl pre-flight.
	try {
		for (let i = 0; i < 5; i++) {
			const r = await runClaude({
				max_tokens: 2048,
				tools: [
					{ type: "web_search_20260209", name: "web_search" },
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
		? await searchReleases(extraction.artist, extraction.title).catch(() => [])
		: [];

	// 3. Escalate to web search when unsure or unmatched.
	if (extraction.confidence < 0.6 || candidates.length === 0) {
		console.info(
			`[analyze] escalating to web search (confidence=${extraction.confidence}, discogs matches=${candidates.length})`,
		);
		const refined = await identifyWithWebSearch(extraction, context);
		if (refined) {
			extraction = refined;
			candidates = await searchReleases(refined.artist, refined.title).catch(
				() => [],
			);
		}
	}

	const best = candidates[0] ?? null;

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
		artist: best?.artist || extraction.artist,
		title: best?.title || extraction.title,
		year: best?.year ?? extraction.year,
		label: best?.label ?? null,
		genre: best?.genre ?? null,
		pitchforkScore: pitchfork?.score ?? null,
		pitchforkUrl: pitchfork?.url ?? null,
		discogsId: best?.discogsId ?? null,
		discogsUrl: best?.discogsUrl ?? null,
		coverImageKey,
		confidence: extraction.confidence,
		candidates,
	};
}
