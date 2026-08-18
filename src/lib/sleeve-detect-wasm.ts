/**
 * Best-effort sleeve-corner detection, preferring the whole-frame Rust/wasm detector
 * (`crates/sleeve-detect`) over the narrow-band TS scan in `photo-processing.ts`.
 *
 * `detectSleeveCorners` there only searches within 18% of the frame edge on each side and
 * bails to `null` if any one side doesn't clear its confidence threshold — assumptions
 * that hold for a tightly-framed, high-contrast capture but not for a sleeve that sits
 * well inside the frame or reads close in tone to its background (a tan cover on a tan
 * wall). The wasm detector runs Canny + contour finding over the whole image instead, so
 * it isn't tied to how tightly the sleeve was framed. See `crates/sleeve-detect/src/lib.rs`
 * for the algorithm and its own test fixtures for the specific cases each detector does
 * and doesn't handle.
 *
 * Loaded dynamically and never throws: any failure to load or instantiate the wasm module
 * (unsupported environment, a bundler that hasn't resolved `.wasm` to a `WebAssembly.Module`
 * the way `@cloudflare/vite-plugin`/wrangler do) is swallowed and treated as "no detection",
 * so this always degrades to the original TS scan rather than breaking capture/reframe.
 */
import { detectSleeveCorners, type RgbaImage } from "#/lib/photo-processing";
import type { NormalizedCorner, NormalizedCorners } from "#/lib/sleeve-corners";

async function detectViaWasm(
	img: RgbaImage,
): Promise<NormalizedCorners | null> {
	try {
		const { detectSleeveCorners: detect } = await import(
			"../../crates/sleeve-detect/pkg/sleeve_detect.js"
		);
		const flat = detect(
			new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength),
			img.width,
			img.height,
		);
		if (flat.length !== 8) return null;
		const corners: NormalizedCorner[] = [];
		for (let i = 0; i < 8; i += 2) corners.push([flat[i], flat[i + 1]]);
		return corners as NormalizedCorners;
	} catch {
		return null;
	}
}

/** The wasm detector first, then the TS band scan — see module doc for why both exist. */
export async function detectSleeveCornersBest(
	img: RgbaImage,
): Promise<NormalizedCorners | null> {
	return (await detectViaWasm(img)) ?? detectSleeveCorners(img);
}
