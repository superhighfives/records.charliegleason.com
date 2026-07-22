/**
 * Small, pure alpha-mask helpers for the Magic matte path — resampling the model output to
 * the content grid, wrapping a grey mask as RGBA for PNG encoding, and bilinearly resizing
 * a single-channel mask. Kept binding-free (no Photon, no `cloudflare:workers`) so BOTH the
 * Worker matte pipeline (`matte.ts`) and the standalone matte container (`containers/matte/`)
 * run the exact same pixel math — this is where subtle edge bugs would hide, so there must
 * be only one copy.
 */

import type { RgbaImage } from "#/lib/photo-processing";

/**
 * Turn a matting model's output into a content-sized alpha mask. The model returns the
 * subject on transparency (RGBA) or a grey mask; we nearest-resample it to the `w`×`h`
 * content and take the alpha channel — or, if the output is fully opaque (a mask-style
 * result with no real alpha), its luminance instead.
 */
export function maskFromModelOutput(
	model: RgbaImage,
	w: number,
	h: number,
): Uint8ClampedArray {
	// Does the model output carry a real alpha channel, or is it fully opaque?
	let hasAlpha = false;
	for (let p = 0; p < model.width * model.height; p++) {
		if (model.data[p * 4 + 3] < 250) {
			hasAlpha = true;
			break;
		}
	}
	const mask = new Uint8ClampedArray(w * h);
	for (let y = 0; y < h; y++) {
		const my = Math.min(model.height - 1, Math.round((y / h) * model.height));
		for (let x = 0; x < w; x++) {
			const mx = Math.min(model.width - 1, Math.round((x / w) * model.width));
			const i = (my * model.width + mx) * 4;
			mask[y * w + x] = hasAlpha
				? model.data[i + 3]
				: 0.2126 * model.data[i] +
					0.7152 * model.data[i + 1] +
					0.0722 * model.data[i + 2];
		}
	}
	return mask;
}

/** Wrap a single-channel mask as an opaque RGBA image (r=g=b=value) for PNG encoding. */
export function grayToRgba(
	mask: Uint8ClampedArray,
	w: number,
	h: number,
): RgbaImage {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const v = mask[i];
		data[i * 4] = v;
		data[i * 4 + 1] = v;
		data[i * 4 + 2] = v;
		data[i * 4 + 3] = 255;
	}
	return { data, width: w, height: h };
}

/**
 * Bilinearly resample a single-channel mask to `tw`×`th`, allocating only the output (no big
 * RGBA temporaries) so the hi-res re-cut stays inside the renderer's memory budget.
 */
export function resizeMask(
	mask: Uint8ClampedArray,
	w: number,
	h: number,
	tw: number,
	th: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(tw * th);
	for (let y = 0; y < th; y++) {
		const sy = ((y + 0.5) * h) / th - 0.5;
		const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
		const y1 = Math.min(h - 1, y0 + 1);
		const fy = sy - Math.floor(sy);
		for (let x = 0; x < tw; x++) {
			const sx = ((x + 0.5) * w) / tw - 0.5;
			const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
			const x1 = Math.min(w - 1, x0 + 1);
			const fx = sx - Math.floor(sx);
			const top =
				mask[y0 * w + x0] + (mask[y0 * w + x1] - mask[y0 * w + x0]) * fx;
			const bot =
				mask[y1 * w + x0] + (mask[y1 * w + x1] - mask[y1 * w + x0]) * fx;
			out[y * tw + x] = top + (bot - top) * fy;
		}
	}
	return out;
}
