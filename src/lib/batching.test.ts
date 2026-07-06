import { describe, expect, it } from "vitest";

import {
	type AnalyzeMessage,
	chunk,
	D1_PARAM_CHUNK,
	QUEUE_BATCH_SIZE,
	toQueueBatches,
} from "./batching";

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("chunk", () => {
	it("returns nothing for an empty list", () => {
		expect(chunk([], 90)).toEqual([]);
	});

	it("keeps a list shorter than the size as a single chunk", () => {
		expect(chunk([1, 2, 3], 90)).toEqual([[1, 2, 3]]);
	});

	it("keeps a list exactly the size as a single chunk", () => {
		const items = range(90);
		const out = chunk(items, 90);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual(items);
	});

	it("splits at the boundary: size + 1 becomes two chunks", () => {
		const out = chunk(range(91), 90);
		expect(out.map((c) => c.length)).toEqual([90, 1]);
	});

	it("splits a large list into full chunks plus a remainder", () => {
		// The 205-record selection from the bug report, at the D1 chunk size.
		const out = chunk(range(205), D1_PARAM_CHUNK);
		expect(out.map((c) => c.length)).toEqual([90, 90, 25]);
	});

	it("preserves order and every element across the split", () => {
		const items = range(205);
		expect(chunk(items, D1_PARAM_CHUNK).flat()).toEqual(items);
	});

	it("throws rather than looping forever on a non-positive size", () => {
		expect(() => chunk([1, 2], 0)).toThrow();
		expect(() => chunk([1, 2], -5)).toThrow();
	});
});

describe("platform limits", () => {
	// These constants exist to stay under hard Cloudflare limits; a well-meaning
	// bump above them would silently reintroduce the bug this module fixes.
	it("keeps the D1 chunk under the 100-bound-parameter ceiling, with headroom", () => {
		// Headroom so a companion `.set(...)` (extra bound columns) can't tip a
		// full chunk over 100.
		expect(D1_PARAM_CHUNK).toBeLessThan(100);
	});

	it("never lets a D1 chunk exceed the parameter ceiling, for any selection size", () => {
		for (const size of [0, 1, 99, 100, 101, 205, 1000]) {
			for (const c of chunk(range(size), D1_PARAM_CHUNK)) {
				expect(c.length).toBeLessThanOrEqual(D1_PARAM_CHUNK);
			}
		}
	});

	it("keeps the queue batch within the 100-message sendBatch cap", () => {
		expect(QUEUE_BATCH_SIZE).toBeLessThanOrEqual(100);
	});
});

describe("toQueueBatches", () => {
	it("produces no batches for an empty id list (so no queue write happens)", () => {
		expect(toQueueBatches([])).toEqual([]);
	});

	it("splits a 205-id enqueue into sendBatch-sized batches", () => {
		const batches = toQueueBatches(range(205));
		expect(batches.map((b) => b.length)).toEqual([100, 100, 5]);
	});

	it("never exceeds the sendBatch cap for any selection size", () => {
		for (const size of [1, 100, 101, 205, 1000]) {
			for (const b of toQueueBatches(range(size))) {
				expect(b.length).toBeLessThanOrEqual(QUEUE_BATCH_SIZE);
			}
		}
	});

	it("wraps each id in a message body, preserving order and count", () => {
		const ids = range(205);
		const bodies = toQueueBatches(ids).flat();
		expect(bodies).toHaveLength(ids.length);
		expect(bodies.map((m) => m.body.recordId)).toEqual(ids);
	});

	it("defaults to the analyze pipeline (no mode) when none is given", () => {
		const [batch] = toQueueBatches([1, 2, 3]);
		for (const message of batch) {
			expect(message.body.mode).toBeUndefined();
		}
	});

	it("stamps the refresh mode onto every message when asked", () => {
		const mode: AnalyzeMessage["mode"] = "refresh";
		const bodies = toQueueBatches(range(150), mode).flat();
		expect(bodies).toHaveLength(150);
		for (const message of bodies) {
			expect(message.body.mode).toBe("refresh");
		}
	});
});
