import { describe, expect, it } from "vitest";

import { packDense } from "#/components/wall/pack";

describe("packDense", () => {
	it("lays 1×1s out row by row", () => {
		const { placements, rows } = packDense([1, 1, 1, 1, 1], 3);
		expect(placements).toEqual([
			{ col: 0, row: 0, span: 1 },
			{ col: 1, row: 0, span: 1 },
			{ col: 2, row: 0, span: 1 },
			{ col: 0, row: 1, span: 1 },
			{ col: 1, row: 1, span: 1 },
		]);
		expect(rows).toBe(2);
	});

	it("backfills the hole a 2×2 leaves, like grid-auto-flow: dense", () => {
		// 3 columns: a 1×1, then a 2×2 that only fits at col 1; the next 1×1
		// backfills (0, 1) beside the 2×2 rather than starting a new row.
		const { placements, cells } = packDense([1, 2, 1, 1], 3);
		expect(placements[1]).toEqual({ col: 1, row: 0, span: 2 });
		expect(placements[2]).toEqual({ col: 0, row: 1, span: 1 });
		expect(placements[3]).toEqual({ col: 0, row: 2, span: 1 });
		expect(Array.from(cells.slice(0, 6))).toEqual([0, 1, 1, 2, 1, 1]);
	});

	it("clamps a span wider than the grid", () => {
		const { placements } = packDense([2], 1);
		expect(placements[0]).toEqual({ col: 0, row: 0, span: 1 });
	});
});
