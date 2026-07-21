import { describe, expect, it, vi } from "vitest";

import { NonRetryableError, withRetry } from "./retry";

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
