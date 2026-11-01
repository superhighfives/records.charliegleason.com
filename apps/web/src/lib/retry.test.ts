import { describe, expect, it, vi } from "vitest";

import {
	isTransientD1Error,
	isTransientReplicateError,
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

describe("isTransientReplicateError", () => {
	it("matches an upstream outage, a poll timeout, and a 429/5xx from the API", () => {
		expect(
			isTransientReplicateError(
				new Error(
					"Replicate prediction ccssck1twxrzy0d1crea34vvz8 failed: Model execution failed (Upstream provider is unavailable)",
				),
			),
		).toBe(true);
		expect(
			isTransientReplicateError(
				new Error("Replicate prediction 66mdcdrfynrnw0d008d9h3736w timed out"),
			),
		).toBe(true);
		expect(
			isTransientReplicateError(
				new Error("Replicate create failed (503): Service Unavailable"),
			),
		).toBe(true);
		expect(
			isTransientReplicateError(
				new Error("Replicate poll failed (429): slow down"),
			),
		).toBe(true);
	});

	it("is false for permanent failures — a missing key, a 4xx, a rejected prompt", () => {
		expect(
			isTransientReplicateError(new Error("REPLICATE_API_KEY is not set")),
		).toBe(false);
		expect(
			isTransientReplicateError(
				new Error("Replicate create failed (422): invalid input"),
			),
		).toBe(false);
		expect(
			isTransientReplicateError(
				new Error(
					"Replicate prediction abc failed: NSFW content detected. Try a different prompt.",
				),
			),
		).toBe(false);
	});
});

describe("withRetry with shouldRetry", () => {
	it("retries only the errors shouldRetry accepts", async () => {
		const op = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("D1_ERROR: internal error; reference = x"),
			)
			.mockResolvedValue("ok");
		await expect(
			withRetry(op, { ...opts, shouldRetry: isTransientD1Error }),
		).resolves.toBe("ok");
		expect(op).toHaveBeenCalledTimes(2);
	});

	it("rethrows any other error at once", async () => {
		const op = vi.fn().mockRejectedValue(new Error("no such table: settings"));
		await expect(
			withRetry(op, { ...opts, shouldRetry: isTransientD1Error }),
		).rejects.toThrow("no such table");
		expect(op).toHaveBeenCalledTimes(1);
	});
});

describe("isTransientD1Error", () => {
	it("spots D1's internal error, including wrapped as a cause (as Drizzle does)", () => {
		const d1 = new Error("D1_ERROR: internal error; reference = 9avbvfbtnd30");
		const wrapped = new Error('Failed query: select "value" from "settings"', {
			cause: d1,
		});
		expect(isTransientD1Error(d1)).toBe(true);
		expect(isTransientD1Error(wrapped)).toBe(true);
	});

	it("leaves real query failures alone", () => {
		const wrapped = new Error("Failed query: select", {
			cause: new Error("D1_ERROR: no such table: settings"),
		});
		expect(isTransientD1Error(wrapped)).toBe(false);
		expect(isTransientD1Error("nope")).toBe(false);
	});
});
