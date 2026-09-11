import type { RgbaImage } from "#/lib/photo-processing";

/**
 * A small palette sampled from a color chip's reference vinyl texture at
 * generation time (see `color-texture.ts`), stored on `colors.palette` as JSON
 * and joined into `PublicRecord` for the collection grid. It drives the album
 * title's on-hover gradient: rather than clipping the *photographic* texture into
 * the glyphs (which split a wide title across the texture's own dark→light sweep
 * and routinely went half-invisible), the title clips a controlled two-stop
 * gradient built from these colors, with lightness clamped per theme in CSS so it
 * always reads. Raw, unclamped hex is stored on purpose — the readability rule
 * lives in the render, tweakable without re-extracting.
 */
export type ColorPalette = {
	/** Weighted-average representative color — the chip's single "hue". */
	dominant: string;
	/**
	 * Gradient endpoints, ordered light → dark. Usually two shades of the vinyl's
	 * own hue; opportunistically two distinct hues when the texture varies. One
	 * entry for a flat, single-color texture.
	 */
	colors: string[];
};

/** How many bins the quantizer collapses each channel into (4 bits → 16 levels). */
const CHANNEL_BITS = 4;
/** Cap on sampled pixels — decode is ~4 MB of RGBA; this keeps the scan cheap. */
const MAX_SAMPLES = 8192;
/** Consider at most this many of the most-populous bins as gradient candidates. */
const TOP_BINS = 8;
/** Below this alpha a pixel is treated as transparent and skipped. */
const MIN_ALPHA = 128;

type Bin = { sumR: number; sumG: number; sumB: number; count: number };

function toHex(r: number, g: number, b: number): string {
	const h = (v: number) =>
		Math.max(0, Math.min(255, Math.round(v)))
			.toString(16)
			.padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}`;
}

/** Perceived luminance, 0–255 (Rec. 709 weights). */
function luminance(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Chroma as a 0–1 fraction — how far the color is from gray. */
function saturation(r: number, g: number, b: number): number {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	return max === 0 ? 0 : (max - min) / max;
}

/**
 * Extract a {@link ColorPalette} from a decoded texture. Pure and deterministic
 * (no I/O, no Photon) so it unit-tests trivially and is safe to import from client
 * code for parsing. Quantizes sampled pixels into a coarse RGB grid, then:
 *   - `dominant` = the bin maximizing population × saturation (so a clear hue wins
 *     over a muddy near-gray).
 *   - `colors`   = the lightest and darkest of the most-populous bins, giving a
 *     visible gradient for both single-hue and multi-hue textures.
 * Returns `null` when the image has no opaque pixels to sample.
 */
export function extractPalette(image: RgbaImage): ColorPalette | null {
	const { data, width, height } = image;
	const totalPixels = width * height;
	if (totalPixels === 0) return null;

	const stride = Math.max(1, Math.floor(totalPixels / MAX_SAMPLES));
	const shift = 8 - CHANNEL_BITS;
	const bins = new Map<number, Bin>();
	let count = 0;

	for (let p = 0; p < totalPixels; p += stride) {
		const i = p * 4;
		const a = data[i + 3];
		if (a < MIN_ALPHA) continue;
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		count++;
		const key =
			((r >> shift) << (CHANNEL_BITS * 2)) |
			((g >> shift) << CHANNEL_BITS) |
			(b >> shift);
		const bin = bins.get(key);
		if (bin) {
			bin.sumR += r;
			bin.sumG += g;
			bin.sumB += b;
			bin.count++;
		} else {
			bins.set(key, { sumR: r, sumG: g, sumB: b, count: 1 });
		}
	}
	if (count === 0) return null;

	const means = [...bins.values()].map((bin) => {
		const r = bin.sumR / bin.count;
		const g = bin.sumG / bin.count;
		const b = bin.sumB / bin.count;
		return {
			r,
			g,
			b,
			count: bin.count,
			lum: luminance(r, g, b),
			sat: saturation(r, g, b),
		};
	});

	// Dominant: the most present *colorful* bin, so a saturated accent beats a
	// larger patch of near-gray. `0.35 +` keeps grays in play when nothing is
	// saturated (a black/clear chip is legitimately achromatic).
	const dominantBin = means.reduce((best, m) =>
		m.count * (0.35 + m.sat) > best.count * (0.35 + best.sat) ? m : best,
	);
	const dominant = toHex(dominantBin.r, dominantBin.g, dominantBin.b);

	// Endpoints: the lightest and darkest of the most-populous bins. Sorting by
	// population first keeps stray specks out of the gradient.
	const top = [...means]
		.sort((a, b) => b.count - a.count)
		.slice(0, TOP_BINS)
		.sort((a, b) => b.lum - a.lum);
	const light = toHex(top[0].r, top[0].g, top[0].b);
	const dark = toHex(
		top[top.length - 1].r,
		top[top.length - 1].g,
		top[top.length - 1].b,
	);
	const colors = light === dark ? [light] : [light, dark];

	return { dominant, colors };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Parse the stored `colors.palette` JSON back into a {@link ColorPalette},
 * validating shape and hex format. Returns `null` for missing/malformed data so
 * callers can fall back to an untinted title.
 */
export function parseColorPalette(
	json: string | null | undefined,
): ColorPalette | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const { dominant, colors } = parsed as Record<string, unknown>;
		if (typeof dominant !== "string" || !HEX_RE.test(dominant)) return null;
		if (!Array.isArray(colors) || colors.length === 0) return null;
		const clean = colors.filter(
			(c): c is string => typeof c === "string" && HEX_RE.test(c),
		);
		if (clean.length === 0) return null;
		return { dominant, colors: clean };
	} catch {
		return null;
	}
}
