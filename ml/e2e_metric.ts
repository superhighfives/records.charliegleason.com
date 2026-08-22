/**
 * End-to-end corner-error metric — the number the admin actually experiences.
 *
 * `train.py` reports the RAW 5-fold out-of-fold error (model output only). In the app, every
 * detection is then de-shrunk and edge-refined (`detectSleeveCornersBest` → `refineToEdges` in
 * src/lib/sleeve-detect-wasm.ts). This harness applies that SAME de-shrink + edge-refine — by
 * importing the real `refineQuadEdgesDetailed`, not a copy — on top of the dumped out-of-fold
 * predictions, so the end-to-end figure can't silently drift from what ships.
 *
 * Inputs (all under ml/data/, produced by the training pipeline):
 *   oof_corners.json  raw out-of-fold predictions per record   (train.py, validating run)
 *   corners.json      raw stored bands → midline labels        (export_dataset.py)
 *   bail_ids.txt      segmentation-bail record ids → the tail  (crates/sleeve-detect tune harness)
 *
 * Run from the repo root:  bun run ml/e2e_metric.ts
 */
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import {
	EDGE_CONFIDENCE_MIN,
	refineQuadEdgesDetailed,
	type RgbaImage,
	toPixelCorners,
} from "#/lib/photo-processing";
import { DESHRINK } from "#/lib/sleeve-detect-wasm";
import type { NormalizedCorners } from "#/lib/sleeve-corners";

const DATA = new URL("./data/", import.meta.url).pathname;

type Quad = [number, number][];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Canonical TL,TR,BR,BL by sum/diff — mirrors ml/metric.py `order_quad`. */
function orderQuad(p: Quad): Quad {
	const s = p.map(([x, y]) => x + y);
	const d = p.map(([x, y]) => x - y);
	const argmin = (a: number[]) => a.indexOf(Math.min(...a));
	const argmax = (a: number[]) => a.indexOf(Math.max(...a));
	return [p[argmin(s)], p[argmax(d)], p[argmax(s)], p[argmin(d)]];
}

/** id → midline label quad (normalised), mirroring ml/metric.py `load_labels`. */
function loadLabels(): Record<string, Quad> {
	const raw = JSON.parse(readFileSync(`${DATA}corners.json`, "utf8"));
	const out: Record<string, Quad> = {};
	for (const [k, v] of Object.entries(raw)) {
		const p = JSON.parse(v as string);
		let mid: Quad;
		if (p && typeof p === "object" && "inner" in p && "outer" in p) {
			const inner = p.inner as Quad;
			const outer = p.outer as Quad;
			mid = inner.map((c, i) => [
				(c[0] + outer[i][0]) / 2,
				(c[1] + outer[i][1]) / 2,
			]);
		} else {
			mid = p as Quad; // legacy single quad
		}
		out[k] = orderQuad(mid);
	}
	return out;
}

/** Mean per-corner euclidean distance, as % of frame — mirrors ml/metric.py `corner_error`. */
function cornerError(pred: Quad, gt: Quad): number {
	const p = orderQuad(pred);
	const g = orderQuad(gt);
	let sum = 0;
	for (let i = 0; i < 4; i++) sum += Math.hypot(p[i][0] - g[i][0], p[i][1] - g[i][1]);
	return (sum / 4) * 100;
}

function deshrink(c: NormalizedCorners): NormalizedCorners {
	const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4;
	const cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
	return c.map(([x, y]) => [
		clamp01(cx + (x - cx) * DESHRINK),
		clamp01(cy + (y - cy) * DESHRINK),
	]) as NormalizedCorners;
}

async function decode(id: string): Promise<RgbaImage> {
	const { data, info } = await sharp(`${DATA}captures/${id}.webp`)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
	};
}

/** The exact app path: de-shrink → edge-refine on the full-res capture (matches refineToEdges). */
function endToEnd(img: RgbaImage, raw: NormalizedCorners): NormalizedCorners {
	const px = toPixelCorners(deshrink(raw), img.width, img.height);
	const { corners } = refineQuadEdgesDetailed(img, px, {
		search: Math.round(Math.min(img.width, img.height) * 0.04),
		minConfidence: EDGE_CONFIDENCE_MIN,
	});
	return corners.map(([x, y]) => [
		clamp01(x / (img.width - 1)),
		clamp01(y / (img.height - 1)),
	]) as NormalizedCorners;
}

/** numpy-style linear-interpolation percentile (np.median == percentile 50). */
function percentile(sorted: number[], p: number): number {
	const n = sorted.length;
	if (!n) return 0;
	const idx = ((n - 1) * p) / 100;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarise(name: string, errs: number[]): string {
	if (!errs.length) return `${name.padEnd(22)} (no scorable items)`;
	const s = [...errs].sort((a, b) => a - b);
	const within = (t: number) => (s.filter((e) => e < t).length / s.length) * 100;
	const over2 = (s.filter((e) => e > 2).length / s.length) * 100;
	return (
		`${name.padEnd(22)} n=${s.length}  med=${percentile(s, 50).toFixed(2)}%  ` +
		`mean=${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2)}%  ` +
		`p90=${percentile(s, 90).toFixed(2)}%  <5%=${within(5).toFixed(0)}%  ` +
		`>2%=${over2.toFixed(0)}%`
	);
}

const labels = loadLabels();
const oof = JSON.parse(readFileSync(`${DATA}oof_corners.json`, "utf8")) as Record<
	string,
	Quad
>;
const bails = new Set(
	existsSync(`${DATA}bail_ids.txt`)
		? readFileSync(`${DATA}bail_ids.txt`, "utf8")
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean)
		: [],
);

const ids = Object.keys(oof).filter((id) => labels[id]);
const raw: Record<string, number> = {};
const e2e: Record<string, number> = {};
for (const id of ids) {
	const q = oof[id] as NormalizedCorners;
	raw[id] = cornerError(q, labels[id]);
	e2e[id] = cornerError(endToEnd(await decode(id), q), labels[id]);
}

const pick = (m: Record<string, number>, keep: (id: string) => boolean) =>
	ids.filter(keep).map((id) => m[id]);
const tail = (id: string) => bails.has(id);

console.log(`scored ${ids.length} records (${bails.size} in tail)\n`);
console.log("RAW (model output only — matches train.py):");
console.log(`  ${summarise("all", pick(raw, () => true))}`);
console.log(`  ${summarise("tail (bails)", pick(raw, tail))}`);
console.log("\nEND-TO-END (de-shrink + edge-refine — what the admin sees):");
console.log(`  ${summarise("all", pick(e2e, () => true))}`);
console.log(`  ${summarise("tail (bails)", pick(e2e, tail))}`);
