import { describe, expect, it, vi } from "vitest";

import {
	isTransientContainerReset,
	NonRetryableError,
	withRetry,
} from "./retry";

// baseMs: 0 → no real backoff waiting, so the exhaustion test doesn't sleep.
const opts = { attempts: 3, baseMs: 0 };

describe("withRetry", () => {
	it("returns the result and stops when op succeeds on the first attempt", async () => {
		const op = vi.fn().mockResolvedValue("ok");
		await expect(withRetry(op, opts)).resolves.toBe("ok");
		expect(op).toHaveBeenCalledTimes(1);
	});

	it("retries a thrown error and returns once a later attempt succeeds", async () => {
		const op = vi
			.fn()
			.mockRejectedValueOnce(new Error("blip"))
			.mockRejectedValueOnce(new Error("blip"))
			.mockResolvedValue("ok");
		await expect(withRetry(op, opts)).resolves.toBe("ok");
		expect(op).toHaveBeenCalledTimes(3);
	});

	it("stops after `attempts` and rethrows the LAST error", async () => {
		const op = vi
			.fn()
			.mockRejectedValueOnce(new Error("first"))
			.mockRejectedValueOnce(new Error("second"))
			.mockRejectedValue(new Error("last"));
		await expect(withRetry(op, opts)).rejects.toThrow("last");
		expect(op).toHaveBeenCalledTimes(3);
	});

	it("fails fast on a NonRetryableError — no further attempts, no backoff", async () => {
		const op = vi.fn().mockRejectedValue(new NonRetryableError("404"));
		await expect(withRetry(op, opts)).rejects.toBeInstanceOf(NonRetryableError);
		// The permanent failure surfaces immediately rather than burning the budget.
		expect(op).toHaveBeenCalledTimes(1);
	});

	it("honours a NonRetryableError raised only on a later attempt", async () => {
		const op = vi
			.fn()
			.mockRejectedValueOnce(new Error("transient"))
			.mockRejectedValue(new NonRetryableError("403"));
		await expect(withRetry(op, opts)).rejects.toBeInstanceOf(NonRetryableError);
		// One transient retry, then the permanent error stops it (2, not the full 3).
		expect(op).toHaveBeenCalledTimes(2);
	});
});

describe("isTransientContainerReset", () => {
	it("matches the DO storage-timeout reset error (full platform message)", () => {
		const err = new Error(
			"Durable Object storage operation exceeded timeout which caused object to be reset.",
		);
		expect(isTransientContainerReset(err)).toBe(true);
	});

	it("matches either half of the message, and non-Error values", () => {
		expect(isTransientContainerReset(new Error("… object to be reset"))).toBe(
			true,
		);
		expect(
			isTransientContainerReset("storage operation exceeded timeout"),
		).toBe(true);
	});

	it("matches the code-update DO reset and the container-rollout exit (the mass-fail signals)", () => {
		expect(
			isTransientContainerReset(
				new Error("Durable Object reset because its code was updated."),
			),
		).toBe(true);
		expect(
			isTransientContainerReset(
				new Error(
					"Container error: Error: Runtime signalled the container to exit due to a new version.",
				),
			),
		).toBe(true);
	});

	it("is false for unrelated failures — so only the reset is retried", () => {
		expect(
			isTransientContainerReset(new Error("matte container 500: boom")),
		).toBe(false);
		expect(
			isTransientContainerReset(new Error("Network connection lost.")),
		).toBe(false);
		expect(isTransientContainerReset(null)).toBe(false);
	});

	it("drives withRetry: retries a reset, fails fast on anything else", async () => {
		// Mirrors postToContainer's classifier — the reset stays retryable, everything
		// else is wrapped NonRetryableError so it surfaces at once.
		const wrap = (err: unknown) => {
			if (isTransientContainerReset(err)) throw err;
			throw new NonRetryableError(
				err instanceof Error ? err.message : String(err),
			);
		};

		const reset = new Error("object to be reset");
		const resettingThenOk = vi
			.fn()
			.mockRejectedValueOnce(reset)
			.mockResolvedValue("ok");
		await expect(
			withRetry(() => resettingThenOk().catch(wrap), opts),
		).resolves.toBe("ok");
		expect(resettingThenOk).toHaveBeenCalledTimes(2);

		const other = vi.fn().mockRejectedValue(new Error("500 boom"));
		await expect(
			withRetry(() => other().catch(wrap), opts),
		).rejects.toBeInstanceOf(NonRetryableError);
		// Non-reset error fails fast — one call, not the full 3.
		expect(other).toHaveBeenCalledTimes(1);
	});
});
