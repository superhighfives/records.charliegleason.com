import { env } from "cloudflare:workers";

/**
 * Minimal Replicate client — the whole integration surface for the professional
 * studio-photo pipeline, mirroring `ai.ts` for Claude. It creates a prediction
 * against an official model and polls it to completion. No SDK: one authed
 * `fetch` against the REST API, so it runs unchanged in the queue consumer.
 *
 * Auth is `REPLICATE_API_KEY` — a runtime secret (`wrangler secret put`, and in
 * `.env.local` for dev). Server-only: never import this into a client bundle.
 */

const API_BASE = "https://api.replicate.com/v1";
const UA = "RecordsCharlieGleasonCom/1.0 +https://records.charliegleason.com";

export interface Prediction {
	id: string;
	status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
	output: unknown;
	error: string | null;
}

function authHeaders(): HeadersInit {
	const token = env.REPLICATE_API_KEY;
	if (!token) throw new Error("REPLICATE_API_KEY is not set");
	return {
		// Replicate's canonical scheme is `Token <token>` (not `Bearer`) — supported
		// across every endpoint, so it's the safe choice.
		Authorization: `Token ${token}`,
		"Content-Type": "application/json",
		"User-Agent": UA,
	};
}

interface RunOpts {
	pollMs?: number;
	timeoutMs?: number;
}

/** Poll a freshly-created prediction to a terminal state; throw unless it succeeded. */
async function pollToDone(
	initial: Prediction,
	{ pollMs = 2000, timeoutMs = 120_000 }: RunOpts,
): Promise<Prediction> {
	let prediction = initial;
	const deadline = Date.now() + timeoutMs;
	while (
		prediction.status !== "succeeded" &&
		prediction.status !== "failed" &&
		prediction.status !== "canceled"
	) {
		if (Date.now() > deadline) {
			throw new Error(`Replicate prediction ${prediction.id} timed out`);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		const poll = await fetch(`${API_BASE}/predictions/${prediction.id}`, {
			headers: authHeaders(),
		});
		if (!poll.ok) {
			throw new Error(
				`Replicate poll failed (${poll.status}): ${await poll.text()}`,
			);
		}
		prediction = (await poll.json()) as Prediction;
	}

	if (prediction.status !== "succeeded") {
		throw new Error(
			`Replicate prediction ${prediction.id} ${prediction.status}: ${
				prediction.error ?? "unknown error"
			}`,
		);
	}
	return prediction;
}

/**
 * Run an OFFICIAL Replicate model (`owner/name`) to completion and return the
 * finished prediction. Creates it, then polls until it reaches a terminal state or
 * the timeout elapses. Throws on an API error, a failed/canceled prediction, or a
 * timeout — the caller decides how to surface it. The wall-clock wait (not CPU) is
 * fine inside a queue consumer.
 *
 * Official only: `/models/{model}/predictions` 404s for community models — use
 * {@link runVersion} for those.
 */
export async function runModel(
	model: string,
	input: Record<string, unknown>,
	opts: RunOpts = {},
): Promise<Prediction> {
	const created = await fetch(`${API_BASE}/models/${model}/predictions`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ input }),
	});
	if (!created.ok) {
		throw new Error(
			`Replicate create failed (${created.status}): ${await created.text()}`,
		);
	}
	return pollToDone((await created.json()) as Prediction, opts);
}

/**
 * Run a COMMUNITY Replicate model pinned to a specific `version` hash, via the
 * `/predictions` endpoint (community models 404 on the official `/models/...`
 * route). Otherwise identical to {@link runModel}: creates, polls, returns the
 * finished prediction or throws.
 */
export async function runVersion(
	version: string,
	input: Record<string, unknown>,
	opts: RunOpts = {},
): Promise<Prediction> {
	const created = await fetch(`${API_BASE}/predictions`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ version, input }),
	});
	if (!created.ok) {
		throw new Error(
			`Replicate create failed (${created.status}): ${await created.text()}`,
		);
	}
	return pollToDone((await created.json()) as Prediction, opts);
}

/**
 * Coerce a model's `output` to a single result URL. Replicate returns either a
 * bare URL string or an array of them depending on the model.
 */
export function firstOutputUrl(output: unknown): string | null {
	if (typeof output === "string") return output;
	if (Array.isArray(output) && typeof output[0] === "string") return output[0];
	return null;
}
