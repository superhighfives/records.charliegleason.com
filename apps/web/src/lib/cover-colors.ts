/**
 * A few key colours from a record's cover, for the record panel's mesh
 * gradient backdrop. Sampled in the browser from the cover thumbnail the
 * panel already shows (same origin, so a canvas can read it).
 */

/** Bits kept per channel when bucketing pixels (4 → 16 levels). */
const CHANNEL_BITS = 4;
/** How far apart (RGB distance) two picks must be to both count. */
const MIN_DISTANCE = 64;

type Bucket = { r: number; g: number; b: number; count: number };

function toHex(r: number, g: number, b: number): string {
	const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Up to `n` distinct colours from RGBA pixel data: the most common colours,
 * favouring saturated ones (a mostly-grey sleeve with a red title gives the
 * red), each far enough from those already picked. Pure, for testing.
 */
export function keyColors(data: Uint8ClampedArray, n = 4): string[] {
	const shift = 8 - CHANNEL_BITS;
	const buckets = new Map<number, Bucket>();
	for (let i = 0; i + 3 < data.length; i += 4) {
		if (data[i + 3] < 128) continue;
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const key =
			((r >> shift) << (2 * CHANNEL_BITS)) |
			((g >> shift) << CHANNEL_BITS) |
			(b >> shift);
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.r += r;
			bucket.g += g;
			bucket.b += b;
			bucket.count++;
		} else buckets.set(key, { r, g, b, count: 1 });
	}
	const ranked = [...buckets.values()]
		.map((k) => {
			const r = k.r / k.count;
			const g = k.g / k.count;
			const b = k.b / k.count;
			const max = Math.max(r, g, b);
			const sat = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
			return { r, g, b, score: k.count * (0.35 + sat) };
		})
		.sort((a, b) => b.score - a.score);
	const picks: { r: number; g: number; b: number }[] = [];
	for (const c of ranked) {
		if (picks.length >= n) break;
		const near = picks.some(
			(p) => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) < MIN_DISTANCE,
		);
		if (!near) picks.push(c);
	}
	return picks.map((c) => toHex(c.r, c.g, c.b));
}

/** Loads `src` and samples its key colours (null if it can't be read). */
export function loadCoverColors(src: string, n = 4): Promise<string[] | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.decoding = "async";
		img.onload = () => {
			try {
				const size = 32;
				const canvas = document.createElement("canvas");
				canvas.width = size;
				canvas.height = size;
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) return resolve(null);
				ctx.drawImage(img, 0, 0, size, size);
				const colors = keyColors(ctx.getImageData(0, 0, size, size).data, n);
				resolve(colors.length > 0 ? colors : null);
			} catch {
				resolve(null);
			}
		};
		img.onerror = () => resolve(null);
		img.src = src;
	});
}
