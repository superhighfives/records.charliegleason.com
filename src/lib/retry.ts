/**
 * A tiny bounded-retry helper, kept dependency-free so it's unit-testable in plain Node
 * (see retry.test.ts) — its callers (`professional.ts`) pull in the Workers `env` binding
 * and Photon WASM and so can't be imported into a test, so the retryable control-flow lives
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
 * A transient Cloudflare error from a container-fronting Durable Object that a retry with a
 * fresh stub recovers. Three shapes, all of which lose only in-memory state and which
 * Cloudflare's guidance is to retry:
 *   - a DO storage op exceeds its ~30s timeout and the platform resets the object mid-request
 *     ("…storage operation exceeded timeout which caused object to be reset");
 *   - the DO is reset because its code was updated ("Durable Object reset because its code was
 *     updated") — a Worker version change landing mid-request;
 *   - during a container rollout the runtime signals the active instance to exit ("Runtime
 *     signalled the container to exit due to a new version") — a platform-initiated instance
 *     replacement, which with no drain grace kills the in-flight request outright.
 * A caller keeps {@link withRetry} retrying these (getRandom re-picks a fresh instance/stub)
 * while classifying everything else as {@link NonRetryableError}. Lives here (dependency-free)
 * so it's testable without importing its Workers-bound caller — same reason as the rest of
 * this module.
 */
export function isTransientContainerReset(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /exceeded timeout|to be reset|code was updated|the container to exit/i.test(
		message,
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `op`, retrying on a thrown error up to `attempts` times with exponential backoff
 * (`baseMs`, then `2×baseMs`, …). A {@link NonRetryableError} short-circuits — rethrown at
 * once, no further attempts — so a permanent failure isn't paid for. Once the attempts are
 * exhausted the last error is rethrown, so a persistent transient still propagates to the
 * caller (its own outer retry / fallback). `op` MUST be idempotent — it can run several times.
 */
export async function withRetry<T>(
	op: () => Promise<T>,
	{ attempts, baseMs }: { attempts: number; baseMs: number },
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await op();
		} catch (err) {
			if (err instanceof NonRetryableError) throw err;
			lastErr = err;
			if (attempt < attempts) await sleep(baseMs * 2 ** (attempt - 1));
		}
	}
	throw lastErr;
}
