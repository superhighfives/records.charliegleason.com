// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
	ambientProgress,
	columnWeight,
	trapezoidWeight,
} from "#/components/collection-grid";

// These two are the load-bearing shape of the touch ambient pass — the plan
// doc records ~10 rounds of fix-then-regress on exactly this trapezoid/falloff
// math, so they're pinned here directly rather than only via a device test.
// Constants baked into the assertions (must track collection-grid.tsx):
//   AMBIENT_CORE_RATIO    = 0.75  → plateau covers the inner 75% of the falloff
//   AMBIENT_FALLOFF_RATIO = 0.62  → ambientProgress' falloff = tileHeight * 0.62
//   COLUMN_CROSSFADE_RATIO = 0.5  → columnWeight's blend band = half a slot

describe("trapezoidWeight", () => {
	// falloffDist 100 → corePx 75, outer ramp band 75..100.
	it("holds a flat plateau at 1 across the whole core", () => {
		expect(trapezoidWeight(0, 100)).toBe(1);
		expect(trapezoidWeight(50, 100)).toBe(1);
		expect(trapezoidWeight(75, 100)).toBe(1); // exactly at the core edge
	});

	it("ramps linearly from 1 to 0 across the outer band", () => {
		// halfway through the 75..100 band → 0.5
		expect(trapezoidWeight(87.5, 100)).toBeCloseTo(0.5, 10);
		// one quarter in → 0.75
		expect(trapezoidWeight(81.25, 100)).toBeCloseTo(0.75, 10);
	});

	it("reaches 0 exactly at the falloff distance", () => {
		expect(trapezoidWeight(100, 100)).toBe(0);
	});

	it("clamps to 0 beyond the falloff distance", () => {
		expect(trapezoidWeight(150, 100)).toBe(0);
		expect(trapezoidWeight(10_000, 100)).toBe(0);
	});

	it("is monotonically non-increasing as distance grows", () => {
		let prev = Number.POSITIVE_INFINITY;
		for (let dist = 0; dist <= 120; dist += 5) {
			const w = trapezoidWeight(dist, 100);
			expect(w).toBeLessThanOrEqual(prev);
			prev = w;
		}
	});

	it("scales the plateau and ramp with the falloff distance", () => {
		// A wider falloff holds full colour further out: corePx is 0.75 * falloff.
		expect(trapezoidWeight(150, 200)).toBe(1); // 150 <= 200*0.75 (=150)
		expect(trapezoidWeight(150, 100)).toBe(0); // same distance, tighter falloff
	});
});

describe("ambientProgress", () => {
	beforeEach(() => {
		// Centre of the viewport is innerHeight / 2 = 400.
		window.innerHeight = 800;
	});

	it("is fully lit for a tile centred on the viewport centre, any height", () => {
		expect(ambientProgress(400, 100)).toBe(1);
		expect(ambientProgress(400, 400)).toBe(1);
	});

	it("is symmetric above and below the viewport centre", () => {
		expect(ambientProgress(400 - 90, 300)).toBe(ambientProgress(400 + 90, 300));
	});

	it("scales its falloff to the tile's own height", () => {
		// tileHeight 200 → falloff 124, core 93. A tile 93px off-centre still at 1;
		// 124px off-centre has fully faded to 0.
		expect(ambientProgress(400 + 93, 200)).toBe(1);
		expect(ambientProgress(400 + 124, 200)).toBe(0);
	});

	it("keeps a taller tile lit further from centre than a shorter one", () => {
		// Same 100px offset: the taller tile's proportionally wider falloff means
		// it is still (partially) lit where the shorter tile has gone dark.
		const tall = ambientProgress(400 + 100, 200);
		const short = ambientProgress(400 + 100, 100);
		expect(tall).toBeGreaterThan(short);
		expect(short).toBe(0);
	});
});

describe("columnWeight", () => {
	// The tile NowShowing names, for a centre line `fraction` down the row.
	const activeIndex = (fraction: number, columns: number) =>
		Math.min(columns - 1, Math.max(0, Math.floor(fraction * columns)));

	it("never lets two tiles sit at full weight at once", () => {
		// The bug this guards: a plateau sized as a ratio of the falloff left
		// both covers in a 2-up row at a flat 1 for the middle quarter of the
		// row's travel, so a scroll lit two records while the bar named one.
		for (const columns of [2, 3, 4]) {
			for (let f = 0; f <= 1; f += 0.002) {
				const full = Array.from({ length: columns }, (_, i) =>
					columnWeight(f, i, columns),
				).filter((w) => w === 1);
				expect(full.length).toBeLessThanOrEqual(1);
			}
		}
	});

	it("peaks on whichever tile NowShowing is naming", () => {
		for (const columns of [2, 3, 4]) {
			for (let f = 0; f <= 1; f += 0.002) {
				const weights = Array.from({ length: columns }, (_, i) =>
					columnWeight(f, i, columns),
				);
				const active = weights[activeIndex(f, columns)];
				// Ties are only ever with the neighbour being crossfaded to,
				// exactly at the boundary where the active tile itself switches.
				expect(active).toBe(Math.max(...weights));
			}
		}
	});

	it("crossfades neighbours at 0.5 each, right on the boundary", () => {
		expect(columnWeight(0.5, 0, 2)).toBeCloseTo(0.5, 10);
		expect(columnWeight(0.5, 1, 2)).toBeCloseTo(0.5, 10);
		expect(columnWeight(1 / 3, 0, 3)).toBeCloseTo(0.5, 10);
		expect(columnWeight(1 / 3, 1, 3)).toBeCloseTo(0.5, 10);
	});

	it("hands a constant total of light to the row", () => {
		for (const columns of [2, 3, 4]) {
			for (let f = 0; f <= 1; f += 0.002) {
				const total = Array.from({ length: columns }, (_, i) =>
					columnWeight(f, i, columns),
				).reduce((a, b) => a + b, 0);
				expect(total).toBeCloseTo(1, 10);
			}
		}
	});

	it("blends over half a slot, straddling the boundary", () => {
		// columns 2 → slot 0.5, band 0.25 wide: 0.375..0.625 around the 0.5
		// boundary. Outside it each tile is flat.
		expect(columnWeight(0.375, 0, 2)).toBe(1);
		expect(columnWeight(0.374, 0, 2)).toBe(1);
		expect(columnWeight(0.5, 0, 2)).toBeCloseTo(0.5, 10);
		expect(columnWeight(0.625, 0, 2)).toBe(0);
		expect(columnWeight(0.9, 0, 2)).toBe(0);
	});

	it("keeps the outer tiles undimmed at the row's own ends", () => {
		// `fraction` runs past 0/1 while the row is still the anchor, and the
		// tile falls back to its undimmed natural progress once it isn't — a
		// taper here would read as a step up at that handoff.
		expect(columnWeight(0, 0, 2)).toBe(1);
		expect(columnWeight(-0.4, 0, 2)).toBe(1);
		expect(columnWeight(1, 1, 2)).toBe(1);
		expect(columnWeight(1.4, 1, 2)).toBe(1);
		expect(columnWeight(1.4, 0, 2)).toBe(0);
	});

	it("leaves a lone tile at full weight everywhere", () => {
		// A 2x2 spanning tile with no same-size neighbour has nothing to blend
		// against; attenuating it read as flicker against its natural progress.
		expect(columnWeight(0, 0, 1)).toBe(1);
		expect(columnWeight(0.5, 0, 1)).toBe(1);
		expect(columnWeight(1, 0, 1)).toBe(1);
	});
});
