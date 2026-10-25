import { describe, expect, it } from "vitest";

import { sleeveEdgeClipPath } from "./sleeve-edge";

/** Parse `polygon(x% y%, …)` back into numeric [x, y] pairs. */
function points(clipPath: string): [number, number][] {
	const inner = clipPath.match(/^polygon\((.*)\)$/)?.[1];
	if (!inner) throw new Error(`not a polygon: ${clipPath}`);
	return inner.split(", ").map((pair) => {
		const [x, y] = pair.split(" ").map((v) => Number.parseFloat(v));
		return [x, y];
	});
}

describe("sleeveEdgeClipPath", () => {
	it("is deterministic per seed", () => {
		expect(sleeveEdgeClipPath(42)).toBe(sleeveEdgeClipPath(42));
	});

	it("varies between seeds", () => {
		expect(sleeveEdgeClipPath(1)).not.toBe(sleeveEdgeClipPath(2));
	});

	it("keeps every point inside the box", () => {
		for (const seed of [0, 1, 7, 310, 99999]) {
			for (const [x, y] of points(sleeveEdgeClipPath(seed))) {
				expect(x).toBeGreaterThanOrEqual(0);
				expect(x).toBeLessThanOrEqual(100);
				expect(y).toBeGreaterThanOrEqual(0);
				expect(y).toBeLessThanOrEqual(100);
			}
		}
	});

	it("stays close to the edge — worn, not torn", () => {
		for (const seed of [3, 11, 250]) {
			for (const [x, y] of points(sleeveEdgeClipPath(seed))) {
				const distanceToEdge = Math.min(x, y, 100 - x, 100 - y);
				expect(distanceToEdge).toBeLessThanOrEqual(1.25);
			}
		}
	});
});
