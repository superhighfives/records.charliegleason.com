import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ getDb: vi.fn() }));
vi.mock("#/db/schema", () => ({ records: {} }));
vi.mock("#/lib/photo-processing", () => ({ assessMatteQuality: vi.fn() }));
vi.mock("#/lib/professional", () => ({ decodeRgba: vi.fn() }));
vi.mock("@sentry/tanstackstart-react", () => ({
	startSpan: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
	captureException: vi.fn(),
}));

import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { getDb } from "#/db";
import { assessMatteQuality } from "#/lib/photo-processing";
import { decodeRgba } from "#/lib/professional";
import { runMatteAudit } from "./matte-audit";

describe("runMatteAudit", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Two due rows, both with a cutout key. The IMAGES/decode step throws for the
	// first (a genuinely corrupt cutout) and succeeds for the second, so this
	// exercises both the per-row error isolation and the follow-on happy path in
	// one sweep.
	const makeDb = (rows: Array<{ id: string; cutoutKey: string | null }>) => {
		const updateWhere = vi.fn().mockResolvedValue(undefined);
		const updateSet = vi.fn(() => ({ where: updateWhere }));
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({
						orderBy: () => ({
							limit: vi.fn().mockResolvedValue(rows),
						}),
					}),
				}),
			}),
			update: () => ({ set: updateSet }),
		};
		(getDb as ReturnType<typeof vi.fn>).mockReturnValue(db);
		return { updateSet, updateWhere };
	};

	it("isolates a decode failure to its own row, leaves checkedAt untouched, and still processes the next row", async () => {
		const { updateSet } = makeDb([
			{ id: "bad", cutoutKey: "bad-key" },
			{ id: "good", cutoutKey: "good-key" },
		]);
		const output = {
			response: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
		};
		const transform = vi.fn(() => ({ output: () => output }));
		env.PHOTOS = {
			get: vi.fn().mockResolvedValue({ body: {} }),
		} as unknown as typeof env.PHOTOS;
		env.IMAGES = {
			input: vi.fn(() => ({ transform })),
		} as unknown as typeof env.IMAGES;
		(decodeRgba as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(() => {
				throw new Error("corrupt cutout");
			})
			.mockReturnValueOnce({
				data: new Uint8ClampedArray(),
				width: 1,
				height: 1,
			});
		(assessMatteQuality as ReturnType<typeof vi.fn>).mockReturnValue({
			tintScore: 0,
			edgeScore: 0,
			tintSuspect: false,
			edgeSuspect: false,
		});

		const result = await runMatteAudit();

		// Both rows were visited (the sweep didn't abort on the first).
		expect(result.checked).toBe(2);
		expect(Sentry.captureException).toHaveBeenCalledTimes(1);
		// Only the successfully-decoded row was persisted — the failing row's
		// checkedAt is left untouched so it retries at the front of the queue.
		expect(updateSet).toHaveBeenCalledTimes(1);
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ professionalMatteAuditReason: null }),
		);
	});

	it("joins every suspect flag, including an inside hole, into the stored reason", async () => {
		const { updateSet } = makeDb([{ id: "flagged", cutoutKey: "flagged-key" }]);
		const output = {
			response: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
		};
		const transform = vi.fn(() => ({ output: () => output }));
		env.PHOTOS = {
			get: vi.fn().mockResolvedValue({ body: {} }),
		} as unknown as typeof env.PHOTOS;
		env.IMAGES = {
			input: vi.fn(() => ({ transform })),
		} as unknown as typeof env.IMAGES;
		(decodeRgba as ReturnType<typeof vi.fn>).mockReturnValue({
			data: new Uint8ClampedArray(),
			width: 1,
			height: 1,
		});
		(assessMatteQuality as ReturnType<typeof vi.fn>).mockReturnValue({
			tintScore: 0,
			edgeScore: 0,
			coverageScore: 1,
			insideScore: 1,
			tintSuspect: false,
			edgeSuspect: false,
			sparseSuspect: false,
			insideSuspect: true,
		});

		const result = await runMatteAudit();

		expect(result.suspects).toBe(1);
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ professionalMatteAuditReason: "inside" }),
		);
	});
});
