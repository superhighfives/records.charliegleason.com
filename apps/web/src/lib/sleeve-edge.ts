/**
 * A per-record sleeve outline as a CSS `clip-path: polygon(...)`. Instead of a
 * true-edged alpha matte, each square cover gets a slightly irregular edge —
 * a gentle wobble along each side and softly worn corners — generated from the
 * record id, so every sleeve looks a little different but always the same.
 *
 * Everything is in percentages of the clipped box and kept small (≤ ~1.2%), so
 * the outline reads as "a real object, not a perfect square" rather than torn.
 */

// Interior points per side — enough for a soft wobble, few enough that the
// polygon stays cheap to rasterise across a few hundred tiles.
const POINTS_PER_SIDE = 7;
// Max inward drift of an edge point.
const EDGE_INSET_MAX = 0.55;
// Corner wear: how far each corner is cut back along both of its sides.
const CORNER_MIN = 0.35;
const CORNER_MAX = 1.2;

/** mulberry32 — tiny deterministic PRNG, good enough for visual jitter. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const fmt = (n: number) => `${Math.round(n * 100) / 100}%`;

/**
 * Inward offsets for one side: a smoothed random walk, so neighbouring points
 * drift together (a wavy edge) instead of zig-zagging (a jagged one).
 */
function sideOffsets(rand: () => number): number[] {
	const out: number[] = [];
	let v = rand() * EDGE_INSET_MAX;
	for (let i = 0; i < POINTS_PER_SIDE; i++) {
		v = v * 0.6 + rand() * EDGE_INSET_MAX * 0.4;
		out.push(v);
	}
	return out;
}

export function sleeveEdgeClipPath(seed: number): string {
	const rand = prng(seed * 2654435761);
	const corner = () => CORNER_MIN + rand() * (CORNER_MAX - CORNER_MIN);
	// Corner cut-backs, clockwise from top-left.
	const [tl, tr, br, bl] = [corner(), corner(), corner(), corner()];
	const pts: [number, number][] = [];

	// Each side runs from just after one corner's cut to just before the next.
	const side = (
		start: number,
		end: number,
		place: (t: number, inset: number) => [number, number],
	) => {
		const offsets = sideOffsets(rand);
		for (let i = 0; i < POINTS_PER_SIDE; i++) {
			const t = start + ((end - start) * (i + 1)) / (POINTS_PER_SIDE + 1);
			pts.push(place(t, offsets[i]));
		}
	};

	pts.push([tl, 0]);
	side(tl, 100 - tr, (t, d) => [t, d]);
	pts.push([100 - tr, 0], [100, tr]);
	side(tr, 100 - br, (t, d) => [100 - d, t]);
	pts.push([100, 100 - br], [100 - br, 100]);
	side(100 - br, bl, (t, d) => [t, 100 - d]);
	pts.push([bl, 100], [0, 100 - bl]);
	side(100 - bl, tl, (t, d) => [d, t]);
	pts.push([0, tl]);

	return `polygon(${pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(", ")})`;
}
