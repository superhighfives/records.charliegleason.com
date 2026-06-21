import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { runClaude } from "#/lib/ai";
import { authMiddleware } from "#/lib/auth";
import { type DiscogsCandidate, searchReleases } from "#/lib/discogs";
import { getPitchforkScore } from "#/lib/the-fork";

/** What the photo flow proposes; the user confirms/edits before saving. */
export interface RecordSuggestion {
	artist: string;
	title: string;
	year: number | null;
	label: string | null;
	genre: string | null;
	pitchforkScore: number | null;
	pitchforkUrl: string | null;
	discogsId: string | null;
	discogsUrl: string | null;
	capturePhotoKey: string;
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

function stripDataUrl(b64: string) {
	const comma = b64.indexOf(",");
	return b64.startsWith("data:") && comma !== -1 ? b64.slice(comma + 1) : b64;
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Read artist/title/year off the cover with Claude vision (forced tool call). */
async function extractFromImage(
	data: string,
	mediaType: string,
): Promise<Extraction> {
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
						text: "Identify the vinyl record from this cover photo. Read the artist and album title exactly as printed. Only set a year if it's clearly shown.",
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
): Promise<Extraction | null> {
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous Anthropic message content
	const messages: Array<any> = [
		{
			role: "user",
			content: `I photographed a vinyl record. A first guess is artist="${partial.artist}", title="${partial.title}". Use web search to confirm the correct artist, album title, and original release year (check Discogs/Wikipedia). When confident, call the "record" tool with the corrected values.`,
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

/** Manual Discogs search, for the pick-list / "wrong match" fallback in capture. */
export const searchDiscogs = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((q: { artist: string; title: string }) => q)
	.handler(({ data }) =>
		Sentry.startSpan({ name: "searchDiscogs" }, () =>
			searchReleases(data.artist, data.title).catch(() => []),
		),
	);

export const analyzePhoto = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: { imageBase64: string; mediaType: string }) => data)
	.handler(({ data }) =>
		Sentry.startSpan(
			{ name: "analyzePhoto" },
			async (): Promise<RecordSuggestion> => {
				const mediaType = data.mediaType || "image/jpeg";
				const raw = stripDataUrl(data.imageBase64);

				// Keep the iPhone shot as a reference (admin only). The displayed cover
				// is sourced from Discogs + resized at save time (see createRecord).
				const ext = mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
				const capturePhotoKey = `captures/${crypto.randomUUID()}.${ext}`;
				await env.PHOTOS.put(capturePhotoKey, base64ToBytes(raw), {
					httpMetadata: { contentType: mediaType },
				});

				// 1. Vision read.
				let extraction = await extractFromImage(raw, mediaType);

				// 2. Discogs lookup.
				let candidates = extraction.artist
					? await searchReleases(extraction.artist, extraction.title).catch(
							() => [],
						)
					: [];

				// 3. Escalate to web search when unsure or unmatched.
				if (extraction.confidence < 0.6 || candidates.length === 0) {
					console.info(
						`[analyze] escalating to web search (confidence=${extraction.confidence}, discogs matches=${candidates.length})`,
					);
					const refined = await identifyWithWebSearch(extraction);
					if (refined) {
						extraction = refined;
						candidates = await searchReleases(
							refined.artist,
							refined.title,
						).catch(() => []);
					}
				}

				const best = candidates[0] ?? null;

				// 4. Pitchfork score (best-effort).
				const pitchfork = await getPitchforkScore(
					extraction.artist,
					extraction.title,
				);

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
					capturePhotoKey,
					confidence: extraction.confidence,
					candidates,
				};
			},
		),
	);
