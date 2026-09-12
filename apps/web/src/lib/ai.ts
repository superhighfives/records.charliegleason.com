import { env } from "cloudflare:workers";

/**
 * Claude via Cloudflare Workers AI **partner models** + Unified Billing — no
 * Anthropic key; Cloudflare holds the credentials and bills your CF account.
 * Routed through the AI Gateway named by `AI_GATEWAY_NAME` (or "default", which
 * auto-creates one). The body is the Anthropic Messages format (messages, tools,
 * tool_choice, image content blocks), passed straight through.
 *
 * This file is the whole AI integration surface — to switch back to BYOK (the
 * Anthropic SDK + ANTHROPIC_API_KEY, which guarantees server-side web_search),
 * only `runClaude` changes.
 */

export const AI_MODEL = "anthropic/claude-sonnet-4.6";

type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: string; [k: string]: unknown };

export interface ClaudeResponse {
	content: Array<ContentBlock>;
	stop_reason?: string | null;
}

export async function runClaude(
	body: Record<string, unknown>,
): Promise<ClaudeResponse> {
	const gateway = env.AI_GATEWAY_NAME || "default";
	const ai = env.AI as unknown as {
		run: (model: string, inputs: unknown, opts?: unknown) => Promise<unknown>;
	};
	const raw = (await ai.run(AI_MODEL, body, { gateway: { id: gateway } })) as {
		content?: Array<ContentBlock>;
		result?: ClaudeResponse;
	};
	// Partner-model responses mirror the provider; some paths wrap in `result`.
	return raw.content ? (raw as ClaudeResponse) : (raw.result as ClaudeResponse);
}
