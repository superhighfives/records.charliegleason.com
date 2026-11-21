import { describe, expect, it } from "vitest";

import type { Record } from "#/db/schema";
import { countRecordAlerts } from "./record-alerts";
import { pagerRecords } from "./record-order";

function record(overrides: Partial<Record>): Record {
	return {
		id: 1,
		status: "complete",
		createdAt: new Date(0),
		masterId: null,
		discogsId: null,
		masterMissing: false,
		releaseMissing: false,
		professionalJobStatus: "idle",
		discogsValueFetchedAt: null,
		discogsValueQueuedAt: null,
		...overrides,
	} as Record;
}

describe("countRecordAlerts", () => {
	it("counts each kind of problem once per record", () => {
		const counts = countRecordAlerts([
			record({ id: 1 }),
			record({ id: 2, masterId: "10" }),
			record({ id: 3, masterId: "11", masterMissing: true }),
			record({ id: 4, masterId: "12", discogsId: "20" }),
			record({ id: 5, status: "failed" }),
		]);
		expect(counts).toEqual({
			brokenLinks: 1,
			unmatched: 2,
			analysisFailed: 1,
			imageFailed: 0,
			needsPressing: 2,
			valuesToFetch: 1,
		});
	});

	it("leaves out a value fetch that is queued, but not one queued long ago", () => {
		const counts = countRecordAlerts([
			record({ id: 1, discogsId: "20", discogsValueQueuedAt: new Date() }),
			record({ id: 2, discogsId: "21", discogsValueQueuedAt: new Date(0) }),
		]);
		expect(counts.valuesToFetch).toBe(1);
	});
});

describe("pagerRecords", () => {
	const rows = [
		record({ id: 1, createdAt: new Date(1) }),
		record({ id: 2, createdAt: new Date(2) }),
		record({ id: 3, createdAt: new Date(3) }),
	];

	it("follows the list's saved order when it holds the open record", () => {
		expect(pagerRecords(rows, [3, 1], 1).map((r) => r.id)).toEqual([3, 1]);
	});

	it("drops deleted records from the saved order", () => {
		expect(pagerRecords(rows, [3, 9, 1], 3).map((r) => r.id)).toEqual([3, 1]);
	});

	it("falls back to newest first when the record isn't in the saved order", () => {
		expect(pagerRecords(rows, [3], 2).map((r) => r.id)).toEqual([3, 2, 1]);
		expect(pagerRecords(rows, null, 2).map((r) => r.id)).toEqual([3, 2, 1]);
	});
});
