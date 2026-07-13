/**
 * Lazy OpenCV.js loader + a document-scanner corner detector, used to *seed* the admin
 * corner editor's handles (the admin then fine-tunes them). Client-only.
 *
 * OpenCV.js is ~11MB of wasm, so it must never touch the main bundle: we self-host it at
 * `public/opencv/opencv.js` and inject a `<script>` on first use (the "Auto-detect"
 * button), caching the load promise. There is no npm dependency and no import — the UMD
 * build assigns `window.cv` and initialises its wasm asynchronously (`onRuntimeInitialized`).
 *
 * Detection is the classic pipeline — greyscale → blur → Canny edges → contours →
 * `approxPolyDP` to a 4-point convex quad — returning the sleeve's corners NORMALISED to
 * 0..1. It returns `null` when it can't find a confident quad (e.g. a low-contrast cover
 * whose artwork tone matches the wood), which is exactly when the manual handles take over.
 */

import {
	type NormalizedCorner,
	type NormalizedCorners,
	orderCorners,
} from "#/lib/sleeve-corners";

// OpenCV.js ships no types; treat the global as opaque. One ignore beats scattering casts.
// biome-ignore lint/suspicious/noExplicitAny: OpenCV.js is an untyped UMD wasm module.
type OpenCv = any;

const OPENCV_SRC = "/opencv/opencv.js";
// Downscale the capture before detection — corners are relative, so accuracy is
// unaffected, but Canny/contours over a smaller image are much faster.
const DETECT_MAX_DIM = 1200;

let loadPromise: Promise<OpenCv> | null = null;

/** Load OpenCV.js once (injecting the script), resolving when its wasm is ready. */
export function loadOpenCv(): Promise<OpenCv> {
	if (loadPromise) return loadPromise;
	loadPromise = new Promise<OpenCv>((resolve, reject) => {
		const win = window as unknown as { cv?: OpenCv };
		const ready = (cv: OpenCv) => {
			// The emscripten build assigns `window.cv` synchronously but initialises its
			// wasm asynchronously. The module is *thenable* (so `await cv` works once
			// ready) — but its `.then` does NOT return a real Promise, so chaining
			// `.catch` on it throws. Wrap in `Promise.resolve` to adopt the thenable
			// safely; fall back to `.Mat`-is-ready / `onRuntimeInitialized` for builds
			// that expose the module directly instead.
			if (cv && typeof cv.then === "function") {
				Promise.resolve(cv).then(resolve, reject);
			} else if (cv?.Mat) {
				resolve(cv);
			} else if (cv) {
				cv.onRuntimeInitialized = () => resolve(cv);
			} else {
				reject(new Error("OpenCV failed to initialise"));
			}
		};
		if (win.cv) return ready(win.cv);
		const script = document.createElement("script");
		script.src = OPENCV_SRC;
		script.async = true;
		script.onload = () => ready(win.cv);
		script.onerror = () => reject(new Error("Could not load OpenCV.js"));
		document.body.appendChild(script);
	});
	return loadPromise;
}

/** Draw an image element onto a fresh canvas, downscaled so its longest side ≤ max. */
function toCanvas(img: HTMLImageElement, max: number): HTMLCanvasElement {
	const w = img.naturalWidth || img.width;
	const h = img.naturalHeight || img.height;
	const scale = Math.min(1, max / Math.max(w, h));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(w * scale));
	canvas.height = Math.max(1, Math.round(h * scale));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas;
}

/**
 * Detect the sleeve's four corners in a loaded capture image via OpenCV, normalised to
 * 0..1 and ordered TL,TR,BR,BL. Returns `null` if no confident quad is found — the caller
 * should then leave the handles where they are for manual placement. Loads OpenCV lazily.
 */
export async function detectSleeveCorners(
	img: HTMLImageElement,
): Promise<NormalizedCorners | null> {
	const cv = await loadOpenCv();
	const canvas = toCanvas(img, DETECT_MAX_DIM);
	const { width, height } = canvas;

	const src = cv.imread(canvas);
	const gray = new cv.Mat();
	const edges = new cv.Mat();
	const contours = new cv.MatVector();
	const hierarchy = new cv.Mat();
	const approx = new cv.Mat();

	try {
		cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
		cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
		cv.Canny(gray, edges, 50, 150);
		cv.findContours(
			edges,
			contours,
			hierarchy,
			cv.RETR_LIST,
			cv.CHAIN_APPROX_SIMPLE,
		);

		const imgArea = width * height;
		let best: NormalizedCorner[] | null = null;
		let bestArea = 0.2 * imgArea; // require the sleeve to fill ≥20% of the frame

		for (let i = 0; i < contours.size(); i++) {
			const c = contours.get(i);
			const peri = cv.arcLength(c, true);
			cv.approxPolyDP(c, approx, 0.02 * peri, true);
			if (approx.rows === 4 && cv.isContourConvex(approx)) {
				const area = cv.contourArea(approx);
				if (area > bestArea) {
					const pts: NormalizedCorner[] = [];
					for (let k = 0; k < 4; k++) {
						pts.push([
							approx.data32S[k * 2] / width,
							approx.data32S[k * 2 + 1] / height,
						]);
					}
					best = pts;
					bestArea = area;
				}
			}
			c.delete();
		}

		return best ? orderCorners(best) : null;
	} finally {
		src.delete();
		gray.delete();
		edges.delete();
		contours.delete();
		hierarchy.delete();
		approx.delete();
	}
}
