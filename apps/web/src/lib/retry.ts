/**
 * A tiny bounded-retry helper, kept dependency-free so it's unit-testable in plain Node
 * (see retry.test.ts) — its callers (`color-texture.ts`) pull in the Workers `env` binding
 * and so can't be imported into a test, so the retryable control-flow lives
 * here instead of inline in them.
 */

/**
 * An error the retry helper must treat as PERMANENT: it's rethrown immediately, without
 * consuming further attempts or backoff, so a failure that won't fix itself surfaces at
 * once. Used to fail fast on a non-2xx HTTP status — mirroring how `discogsFetch` returns a
 * 401/404 straight away rather than burning its retry budget on it.
 */
export class NonRetryableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NonRetryableError";
	}
}

/**
 * A transient Replicate failure that a fresh prediction recovers: the upstream model
 * provider being briefly unavailable ("Model execution failed (Upstream provider is
 * unavailable)", RECORDS-29), a prediction stalling past our poll timeout, or a
 * 429/5xx from the create/poll endpoints. Everything else — a missing API key, a
 * rejected prompt, a 4xx — is permanent, so the color-texture job fails fast on it
 * rather than paying for two more predictions. Dependency-free + testable.
 */
export function isTransientReplicateError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /Upstream provider is unavailable|prediction \S+ timed out|Replicate (create|poll) failed \((429|5\d\d)\)/i.test(
		message,
	);
}

/**
 * Cloudflare D1's own transient failure — `D1_ERROR: internal error; reference
 * = …` — which a second try a moment later gets past (RECORDS-2A: a handful a
 * week on the collection's settings read). Drizzle wraps it in its own
 * "Failed query" error, so the `cause` chain is checked too. Anything else
 * (a missing table, bad SQL) is real and isn't retried. Dependency-free +
 * testable.
 */
export function isTransientD1Error(err: unknown): boolean {
	for (let e: unknown = err, depth = 0; e != null && depth < 5; depth++) {
		const message = e instanceof Error ? e.message : String(e);
		if (/D1_ERROR: internal error/i.test(message)) return true;
		e = e instanceof Error ? e.cause : null;
	}
	return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `op`, retrying on a thrown error up to `attempts` times with exponential backoff
 * (`baseMs`, then `2×baseMs`, …). A {@link NonRetryableError} short-circuits — rethrown at
 * once, no further attempts — so a permanent failure isn't paid for. Once the attempts are
 * exhausted the last error is rethrown, so a persistent transient still propagates to the
 * caller (its own outer retry / fallback). `op` MUST be idempotent — it can run several times.
 * `shouldRetry`, when given, limits retries to the errors it accepts; any other is rethrown
 * at once, like a {@link NonRetryableError}.
 */
export async function withRetry<T>(
	op: () => Promise<T>,
	{
		attempts,
		baseMs,
		shouldRetry,
	}: {
		attempts: number;
		baseMs: number;
		shouldRetry?: (err: unknown) => boolean;
	},
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await op();
		} catch (err) {
			if (err instanceof NonRetryableError) throw err;
			if (shouldRetry && !shouldRetry(err)) throw err;
			lastErr = err;
			if (attempt < attempts) await sleep(baseMs * 2 ** (attempt - 1));
		}
	}
	throw lastErr;
}
