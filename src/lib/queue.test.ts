import { describe, expect, it } from "vitest";

import type { Record } from "#/db/schema";
import { isProfessionalStale, PROFESSIONAL_STALE_MS } from "./queue";

/** Minimal stand-in — `isProfessionalStale` only reads these two fields. */
const row = (
	professionalStatus: Record["professionalStatus"],
	updatedAt: Date | null,
): Pick<Record, "professionalStatus" | "updatedAt"> => ({
	professionalStatus,
	updatedAt,
});

const NOW = PROFESSIONAL_STALE_MS * 10; // an arbitrary "now" comfortably past epoch

describe("isProfessionalStale", () => {
	it("is false for terminal / idle statuses regardless of age", () => {
		const ancient = new Date(0);
		for (const status of ["idle", "ready", "approved", "failed"] as const) {
			expect(isProfessionalStale(row(status, ancient), NOW)).toBe(false);
		}
	});

	it("is false for an in-flight job still within the window", () => {
		const justStarted = new Date(NOW - (PROFESSIONAL_STALE_MS - 1));
		expect(isProfessionalStale(row("processing", justStarted), NOW)).toBe(
			false,
		);
		expect(isProfessionalStale(row("pending", justStarted), NOW)).toBe(false);
	});

	it("is true once an in-flight job passes the window", () => {
		const stalled = new Date(NOW - PROFESSIONAL_STALE_MS);
		expect(isProfessionalStale(row("processing", stalled), NOW)).toBe(true);
		expect(isProfessionalStale(row("pending", stalled), NOW)).toBe(true);
	});

	it("treats a missing updatedAt as always stale", () => {
		expect(isProfessionalStale(row("processing", null), NOW)).toBe(true);
	});
});
