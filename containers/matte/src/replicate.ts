/**
 * Minimal Replicate client for the container — mirrors `src/lib/replicate.ts`, but takes
 * the token as an argument (the container has no `cloudflare:workers` env; the Worker passes
 * `REPLICATE_API_KEY` in on each request). Creates a prediction against a pinned version and
 * polls it to completion.
 */

const API_BASE = "https://api.replicate.com/v1";
const UA =
	"RecordsCharlieGleasonCom-Matte/1.0 +https://records.charliegleason.com";

export interface Prediction {
	id: string;
	status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
	output: unknown;
	error: string | null;
}

function authHeaders(token: string): Record<string, string> {
	// Replicate's canonical scheme is `Token <token>` (not `Bearer`).
	return {
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
	token: string,
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
		await new Promise((r) => setTimeout(r, pollMs));
		const poll = await fetch(`${API_BASE}/predictions/${prediction.id}`, {
			headers: authHeaders(token),
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

/** Run a pinned Replicate model `version` to completion; throws on API/timeout/failure. */
export async function runVersion(
	token: string,
	version: string,
	input: Record<string, unknown>,
	opts: RunOpts = {},
): Promise<Prediction> {
	const created = await fetch(`${API_BASE}/predictions`, {
		method: "POST",
		headers: authHeaders(token),
		body: JSON.stringify({ version, input }),
	});
	if (!created.ok) {
		throw new Error(
			`Replicate create failed (${created.status}): ${await created.text()}`,
		);
	}
	return pollToDone(token, (await created.json()) as Prediction, opts);
}

/** Coerce a model's `output` to a single result URL (bare string or array). */
export function firstOutputUrl(output: unknown): string | null {
	if (typeof output === "string") return output;
	if (Array.isArray(output) && typeof output[0] === "string") return output[0];
	return null;
}
