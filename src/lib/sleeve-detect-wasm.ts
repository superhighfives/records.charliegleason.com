/**
 * Best-effort sleeve-corner detection, as a three-tier cascade (best first, each tier
 * degrading to the next on failure):
 *
 *   1. The learned corner-regressor (`crates/sleeve-corner-net`) — a MobileNetV3-small net
 *      trained on the admin's own crops (see `ml/README.md`). It predicts the four corners
 *      directly rather than segmenting, so it handles the ~14% tail the segmentation detector
 *      bails on (dark/pale sleeves filling the frame, busy artwork) — cutting that tail's
 *      median corner error from ~41% to ~1.8% of the frame in offline 5-fold validation, and
 *      matching or beating the segmentation detector on the easy cases too. It always returns
 *      a quad (a regressor can't bail), so tiers 2–3 only run if its wasm fails to load.
 *   2. The whole-frame segmentation detector (`crates/sleeve-detect`) — YCbCr-whitened
 *      foreground segmentation + min-area-rect. Kept as a fallback for environments where the
 *      net's wasm can't load.
 *   3. The narrow-band TS scan (`detectSleeveCorners` in `photo-processing.ts`) — searches
 *      within 18% of each frame edge and bails unless every side clears its confidence gate.
 *
 * Whichever tier wins gets the *region* right but is off by ~1–3% of the frame; the result is
 * then edge-refined (see {@link refineToEdges}) to snap each side to the true sleeve boundary,
 * so the seeded band is tight rather than "close, needs a nudge". The net's output is also
 * de-shrunk first to cancel its small inward regression bias (see {@link DESHRINK}).
 *
 * Every detected quad seeds the corner editor for the admin to review/nudge (it is never
 * committed blindly), which is what makes tier 1 safe despite having no confidence head yet:
 * an out-of-distribution miss is caught by the human before it persists.
 *
 * All wasm tiers load dynamically and never throw: any failure to load or instantiate a
 * module (unsupported environment, a bundler that hasn't resolved `.wasm` to a
 * `WebAssembly.Module` the way `@cloudflare/vite-plugin`/wrangler do) is swallowed and
 * treated as "no detection", so this always degrades rather than breaking capture/reframe.
 */
import {
	detectSleeveCorners,
	EDGE_CONFIDENCE_MIN,
	type RgbaImage,
	refineQuadEdgesDetailed,
	toPixelCorners,
} from "#/lib/photo-processing";
import type { NormalizedCorner, NormalizedCorners } from "#/lib/sleeve-corners";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// The learned net regresses each corner ~0.5% of the frame *inward* on average (ordinary
// MSE regression-to-the-mean), so its raw quad sits a hair inside the true edge. Expand
// it from its own centroid by this factor to re-centre the edge-refinement search band
// (below) on the true boundary rather than just inside it. Measured over the 5-fold
// out-of-fold predictions; see ml/README.md.
const DESHRINK = 1.005;

function toCorners(flat: ArrayLike<number>): NormalizedCorners | null {
	if (flat.length !== 8) return null;
	const corners: NormalizedCorner[] = [];
	for (let i = 0; i < 8; i += 2) corners.push([flat[i], flat[i + 1]]);
	return corners as NormalizedCorners;
}

function deshrink(c: NormalizedCorners): NormalizedCorners {
	const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4;
	const cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
	return c.map(([x, y]) => [
		clamp01(cx + (x - cx) * DESHRINK),
		clamp01(cy + (y - cy) * DESHRINK),
	]) as NormalizedCorners;
}

/**
 * Snap a detector's coarse quad to the sleeve's true edges. Every detector gets the region
 * roughly right but is off by ~1–3% of the frame (~20–60px on a 2048px capture — visibly
 * "needs a nudge"). The true edge is a strong, full-length colour gradient the seed already
 * sits beside, so {@link refineQuadEdgesDetailed} slides each edge along its normal to that
 * gradient, weighted toward the seed and reverting any low-confidence edge back to the seed
 * line (so a genuinely ambiguous edge is never made worse). This is the same refinement the
 * matte pipeline runs at Apply time, brought forward to detect so the seeded band is tight.
 * Runs on the full-resolution capture. Never throws — falls back to the unrefined seed.
 */
function refineToEdges(
	img: RgbaImage,
	corners: NormalizedCorners,
): NormalizedCorners {
	try {
		const px = toPixelCorners(corners, img.width, img.height);
		const { corners: refined } = refineQuadEdgesDetailed(img, px, {
			// The seed is within a few % of the edge; a ~4% band covers that without
			// letting the search wander onto a distant internal graphic line. Tuned
			// offline (ml/): 4% gave the best error/regression trade-off over 6–8%.
			search: Math.round(Math.min(img.width, img.height) * 0.04),
			minConfidence: EDGE_CONFIDENCE_MIN,
		});
		return refined.map(([x, y]) => [
			clamp01(x / (img.width - 1)),
			clamp01(y / (img.height - 1)),
		]) as NormalizedCorners;
	} catch {
		return corners;
	}
}

async function detectViaNet(img: RgbaImage): Promise<NormalizedCorners | null> {
	try {
		const { detectSleeveCornersNet: detect } = await import(
			"../../crates/sleeve-corner-net/pkg/sleeve_corner_net.js"
		);
		const corners = toCorners(
			detect(
				new Uint8Array(
					img.data.buffer,
					img.data.byteOffset,
					img.data.byteLength,
				),
				img.width,
				img.height,
			),
		);
		return corners ? deshrink(corners) : null;
	} catch {
		return null;
	}
}

async function detectViaWasm(
	img: RgbaImage,
): Promise<NormalizedCorners | null> {
	try {
		const { detectSleeveCorners: detect } = await import(
			"../../crates/sleeve-detect/pkg/sleeve_detect.js"
		);
		return toCorners(
			detect(
				new Uint8Array(
					img.data.buffer,
					img.data.byteOffset,
					img.data.byteLength,
				),
				img.width,
				img.height,
			),
		);
	} catch {
		return null;
	}
}

/**
 * Learned net → segmentation wasm → TS band scan, then edge-refined to the true boundary.
 * See module doc for the cascade rationale and {@link refineToEdges} for the refinement.
 */
export async function detectSleeveCornersBest(
	img: RgbaImage,
): Promise<NormalizedCorners | null> {
	const seed =
		(await detectViaNet(img)) ??
		(await detectViaWasm(img)) ??
		detectSleeveCorners(img);
	return seed ? refineToEdges(img, seed) : null;
}
