import { env } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";

/** Model used for cover extraction + web-search identification. */
export const AI_MODEL = "claude-sonnet-4-6";

/**
 * Anthropic client, fronted by Cloudflare AI Gateway when configured (caching,
 * logging, rate-limiting). The gateway's `/anthropic` path is a transparent
 * passthrough, so the full Messages API — including the server-side `web_search`
 * tool — works unchanged. Falls back to api.anthropic.com if no gateway is set.
 */
export function getAnthropic() {
	const account = env.CLOUDFLARE_ACCOUNT_ID;
	const gateway = env.AI_GATEWAY_NAME;
	const baseURL =
		account && gateway
			? `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/anthropic`
			: undefined;

	return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL });
}
