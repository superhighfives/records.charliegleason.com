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
 * Every detected quad seeds the corner editor for the admin to review/nudge (it is never
 * committed blindly), which is what makes tier 1 safe despite having no confidence head yet:
 * an out-of-distribution miss is caught by the human before it persists.
 *
 * All wasm tiers load dynamically and never throw: any failure to load or instantiate a
 * module (unsupported environment, a bundler that hasn't resolved `.wasm` to a
 * `WebAssembly.Module` the way `@cloudflare/vite-plugin`/wrangler do) is swallowed and
 * treated as "no detection", so this always degrades rather than breaking capture/reframe.
 */
import { detectSleeveCorners, type RgbaImage } from "#/lib/photo-processing";
import type { NormalizedCorner, NormalizedCorners } from "#/lib/sleeve-corners";

function toCorners(flat: ArrayLike<number>): NormalizedCorners | null {
	if (flat.length !== 8) return null;
	const corners: NormalizedCorner[] = [];
	for (let i = 0; i < 8; i += 2) corners.push([flat[i], flat[i + 1]]);
	return corners as NormalizedCorners;
}

async function detectViaNet(img: RgbaImage): Promise<NormalizedCorners | null> {
	try {
		const { detectSleeveCornersNet: detect } = await import(
			"../../crates/sleeve-corner-net/pkg/sleeve_corner_net.js"
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

/** Learned net → segmentation wasm → TS band scan. See module doc for the cascade rationale. */
export async function detectSleeveCornersBest(
	img: RgbaImage,
): Promise<NormalizedCorners | null> {
	return (
		(await detectViaNet(img)) ??
		(await detectViaWasm(img)) ??
		detectSleeveCorners(img)
	);
}
