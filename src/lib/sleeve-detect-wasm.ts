/**
 * Best-effort sleeve-corner detection. Two detectors that fail in *different* places are run
 * and reconciled, then the winner is edge-refined to the true boundary and returned with a
 * confidence score so the admin knows how hard to scrutinise the seed:
 *
 *   • The learned corner-regressor (`crates/sleeve-corner-net`) — a MobileNetV3-small net
 *     trained on the admin's own crops (see `ml/README.md`). It predicts the four corners
 *     directly and wins on the ~14% tail the segmentation detector bails on (dark/pale sleeves
 *     filling the frame, busy artwork): offline it cuts that tail's median corner error from
 *     ~41% to ~1.8% of the frame, and matches or beats segmentation on the easy cases. But it
 *     *always* returns a quad (a regressor can't bail), so on out-of-distribution input — a
 *     neon-pink sleeve the training set never contained — it regresses toward a frame-filling
 *     mean and returns that garbage just as confidently as a good fit. It has no confidence
 *     head of its own (yet — see `ml/train.py`).
 *
 *   • The whole-frame segmentation detector (`crates/sleeve-detect`) — YCbCr-whitened
 *     foreground segmentation + min-area-rect. It *does* know when it's confident (it bails on
 *     ~14% of captures via its rectangularity/area/tilt gates) and it excels at exactly what
 *     the net is worst at: a blob of distinct colour on a plain background. A hot-pink sleeve
 *     on tan card segments at rectangularity ~0.96 — the easiest input it can get.
 *
 * These strengths are complementary, so we don't cascade net-then-segmentation-only-on-load-
 * failure any more (that let a confident-but-wrong net suppress a segmentation that would have
 * nailed the crop). Instead {@link reconcile} runs both and, when a confident, accepted
 * segmentation *disagrees* with the net, treats that as the net being out-of-distribution and
 * prefers the colour result. See `detect_sleeve_corners_scored` in the Rust crate.
 *
 * Whichever detector wins gets the *region* roughly right but is off by ~1–3% of the frame;
 * the result is edge-refined (see {@link refineToEdges}) to snap each side to the true sleeve
 * boundary. The net's output is de-shrunk first to cancel its small inward regression bias
 * (see {@link DESHRINK}).
 *
 * Every detected quad still seeds the corner editor for the admin to review/nudge — it is
 * never committed blindly. The {@link SleeveDetection.confidence} score doesn't change that;
 * it tells the admin (and the UI) *how much* to trust the seed, and flags the low-confidence
 * ones that are worth a careful look (and are the best candidates for the next retrain).
 *
 * All wasm tiers load dynamically and never throw: any failure to load or instantiate a module
 * (unsupported environment, a bundler that hasn't resolved `.wasm` to a `WebAssembly.Module`
 * the way `@cloudflare/vite-plugin`/wrangler do) is swallowed and treated as "no detection",
 * so this always degrades rather than breaking capture/reframe.
 */
import {
	detectSleeveCorners,
	EDGE_CONFIDENCE_MIN,
	type EdgeConfidence,
	type RgbaImage,
	refineQuadEdgesDetailed,
	toPixelCorners,
} from "#/lib/photo-processing";
import type { NormalizedCorner, NormalizedCorners } from "#/lib/sleeve-corners";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Which detector produced the returned seed — surfaced to the admin so a low-confidence or
 *  overridden detection reads sensibly ("colour segmentation, because the two detectors
 *  disagreed") rather than as an unexplained bad crop. */
export type DetectionSource =
	| "net"
	| "segmentation"
	| "segmentation-override"
	| "band-scan";

const DETECTION_SOURCES = new Set<DetectionSource>([
	"net",
	"segmentation",
	"segmentation-override",
	"band-scan",
]);

/** Narrows a free-text DB value to {@link DetectionSource}, so a decoupled or manually-edited
 *  column falls back to "net" instead of silently mislabeling the confidence badge. */
export function isDetectionSource(value: string): value is DetectionSource {
	return DETECTION_SOURCES.has(value as DetectionSource);
}

export interface SleeveDetection {
	corners: NormalizedCorners;
	/**
	 * How trustworthy the seed is, 0..1. Not a probability — a blend of the signals below,
	 * calibrated to three bands the UI reads: `>= 0.75` high (agree / cleanly segmented),
	 * `>= 0.45` medium (single detector, unverified), `< 0.45` low (scrutinise). See
	 * {@link confidenceBand}.
	 */
	confidence: number;
	source: DetectionSource;
	/** Raw signals behind {@link confidence}, kept for telemetry / tuning — not shown as-is. */
	signals: {
		/** Corner-agreement between the net and segmentation quads (0..1), or null if one is
		 *  absent. 1 = identical, 0 = ≥15% of the frame apart. */
		agreement: number | null;
		/** Segmentation self-confidence from its rectangularity (0..1), or null if it found
		 *  no blob. */
		segRectangularity: number | null;
		segAccepted: boolean;
		/** The net's own confidence from its heteroscedastic head (0..1), or null for a legacy
		 *  model without an uncertainty output (until the next retrain — see ml/train.py). */
		netConfidence: number | null;
		/** Fraction of the four edges the edge-refine locked onto a real boundary (0..1). */
		edgeLock: number;
	};
}

export type ConfidenceBand = "high" | "medium" | "low";

export function confidenceBand(confidence: number): ConfidenceBand {
	if (confidence >= 0.75) return "high";
	if (confidence >= 0.45) return "medium";
	return "low";
}

// The learned net regresses each corner ~0.5% of the frame *inward* on average (ordinary
// MSE regression-to-the-mean), so its raw quad sits a hair inside the true edge. Expand
// it from its own centroid by this factor to re-centre the edge-refinement search band
// (below) on the true boundary rather than just inside it. Measured over the 5-fold
// out-of-fold predictions; see ml/README.md.
const DESHRINK = 1.005;

// Corner-agreement scale: two quads whose corresponding corners sit this far apart on average
// (as a fraction of the frame) count as fully disagreeing (agreement 0). 15% is well beyond
// the ~1–3% a correct-but-coarse detector is off by, so honest agreement stays near 1 and only
// a genuine divergence (an OOD net miss vs a clean segmentation) drives it toward 0.
const AGREE_SCALE = 0.15;
// Net↔segmentation corner-agreement at/above which the two are considered to concur. Below it
// (with a confident segmentation) we treat the net as out-of-distribution and let colour win.
const AGREE_MIN = 0.6;
// Segmentation self-confidence (from rectangularity) at/above which it's trusted to override a
// disagreeing net. 0.7 maps to rectangularity ~0.83 — a blob that fills most of its rectangle.
const SEG_STRONG = 0.7;
// The net's per-corner uncertainty (sigma, frame units) at which its self-confidence hits 0. A
// well-localised corner sits at ~1–3%; 10% is a corner the net has essentially no idea about.
const NET_SIGMA_SCALE = 0.1;

/** The net's mean per-corner sigma (frame units) mapped to a 0..1 self-confidence, or null when
 *  the model has no uncertainty head yet. */
function netConfidence(sigma: number | null): number | null {
	return sigma === null ? null : clamp01(1 - sigma / NET_SIGMA_SCALE);
}

/** Segmentation rectangularity (~0.55 gate … ~0.98 perfect) mapped to a 0..1 self-confidence. */
function segScore(rectangularity: number): number {
	return clamp01((rectangularity - 0.55) / (0.95 - 0.55));
}

/** Mean per-corner euclidean distance between two normalised quads, mapped to a 0..1 agreement
 *  (1 = identical). Both quads are TL,TR,BR,BL normalised, so corners correspond directly —
 *  this is the same per-corner metric `ml/metric.py` scores the detectors on. */
function cornerAgreement(a: NormalizedCorners, b: NormalizedCorners): number {
	let sum = 0;
	for (let i = 0; i < 4; i++) {
		sum += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
	}
	return clamp01(1 - sum / 4 / AGREE_SCALE);
}

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
 * Snap a detector's coarse quad to the sleeve's true edges, returning the per-edge confidence
 * alongside so the orchestrator can fold "did the edges actually lock onto a boundary?" into
 * the detection confidence. Every detector gets the region roughly right but is off by ~1–3%
 * of the frame (~20–60px on a 2048px capture — visibly "needs a nudge"). The true edge is a
 * strong, full-length colour gradient the seed already sits beside, so
 * {@link refineQuadEdgesDetailed} slides each edge along its normal to that gradient, weighted
 * toward the seed and reverting any low-confidence edge back to the seed line (so a genuinely
 * ambiguous edge is never made worse). This is the same refinement the matte pipeline runs at
 * Apply time, brought forward to detect. Runs on the full-resolution capture. Never throws —
 * falls back to the unrefined seed with empty confidence.
 */
function refineToEdges(
	img: RgbaImage,
	corners: NormalizedCorners,
): { corners: NormalizedCorners; confidence: EdgeConfidence | null } {
	try {
		const px = toPixelCorners(corners, img.width, img.height);
		const { corners: refined, confidence } = refineQuadEdgesDetailed(img, px, {
			// The seed is within a few % of the edge; a ~4% band covers that without letting
			// the search wander onto a distant internal graphic line. Tuned offline (ml/): 4%
			// gave the best error/regression trade-off over 6–8%.
			search: Math.round(Math.min(img.width, img.height) * 0.04),
			minConfidence: EDGE_CONFIDENCE_MIN,
		});
		return {
			corners: refined.map(([x, y]) => [
				clamp01(x / (img.width - 1)),
				clamp01(y / (img.height - 1)),
			]) as NormalizedCorners,
			confidence,
		};
	} catch {
		return { corners, confidence: null };
	}
}

/** The learned net's result: corners plus its own mean per-corner uncertainty (frame units), or
 *  null sigma for a legacy model without an uncertainty head. */
interface NetResult {
	corners: NormalizedCorners;
	sigma: number | null;
}

async function detectViaNet(img: RgbaImage): Promise<NetResult | null> {
	try {
		const { detectSleeveCornersNet: detect } = await import(
			"../../crates/sleeve-corner-net/pkg/sleeve_corner_net.js"
		);
		// [x0,y0,..x3,y3] (len 8) or that plus 4 per-corner sigmas (len 12) — see the crate.
		const flat = detect(
			new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength),
			img.width,
			img.height,
		) as Float64Array | number[];
		const corners = toCorners(Array.from(flat).slice(0, 8));
		if (!corners) return null;
		const sigma =
			flat.length >= 12 ? (flat[8] + flat[9] + flat[10] + flat[11]) / 4 : null;
		return { corners: deshrink(corners), sigma };
	} catch {
		return null;
	}
}

/** Segmentation result plus its self-confidence signals — the reconciliation input from
 *  `detect_sleeve_corners_scored`. */
interface SegResult {
	corners: NormalizedCorners;
	accepted: boolean;
	rectangularity: number;
}

async function detectViaSeg(img: RgbaImage): Promise<SegResult | null> {
	try {
		const { detectSleeveCornersScored: detect } = await import(
			"../../crates/sleeve-detect/pkg/sleeve_detect.js"
		);
		// [accepted, rectangularity, blob_area_frac, x0,y0, x1,y1, x2,y2, x3,y3] or [].
		const flat = detect(
			new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength),
			img.width,
			img.height,
		) as Float64Array | number[];
		if (flat.length !== 11) return null;
		const corners = toCorners(Array.from(flat).slice(3));
		if (!corners) return null;
		return { corners, accepted: flat[0] >= 0.5, rectangularity: flat[1] };
	} catch {
		return null;
	}
}

/**
 * Reconcile the two detectors into one seed + a provisional confidence, before edge-refine.
 * The policy, in order:
 *   1. Both ran and a confident, *accepted* segmentation disagrees with the net → the net is
 *      out-of-distribution; take the colour quad ("segmentation-override"). The result is
 *      trustworthy (segmentation is self-confident here) but a detector conflict still warrants
 *      a human glance — `detectionBadge` always shows the scrutinise treatment for this source
 *      regardless of the numeric confidence (the cap below isn't itself below the high-band
 *      threshold; the UI-level override is what guarantees the glance).
 *   2. The net ran → take it (its on-distribution accuracy beats segmentation). Confidence is
 *      high when segmentation independently agrees, middling when the net is unverified.
 *   3. Only segmentation ran (net wasm absent) → take it, confidence from its own gates.
 * Returns null when neither wasm detector produced a quad; the caller falls back to the TS
 * band scan.
 */
function reconcile(
	net: NetResult | null,
	seg: SegResult | null,
): {
	corners: NormalizedCorners;
	source: DetectionSource;
	base: number;
	agreement: number | null;
} | null {
	const agreement =
		net && seg ? cornerAgreement(net.corners, seg.corners) : null;
	const nc = net ? netConfidence(net.sigma) : null;

	// Override the net with an accepted colour segmentation when the two disagree AND either the
	// segmentation is confident in its own right, or the net says it's unsure (its own low
	// self-confidence, once the model has an uncertainty head). Both point to the same thing: the
	// net is out of its depth and colour is the safer bet.
	if (
		net &&
		seg &&
		seg.accepted &&
		agreement !== null &&
		agreement < AGREE_MIN &&
		(segScore(seg.rectangularity) >= SEG_STRONG || (nc !== null && nc < 0.4))
	) {
		return {
			corners: seg.corners,
			source: "segmentation-override",
			base: Math.min(0.8, 0.5 + 0.4 * segScore(seg.rectangularity)),
			agreement,
		};
	}

	if (net) {
		// Verified by an agreeing segmentation → strong; otherwise a single unverified opinion.
		let base =
			agreement !== null && agreement >= AGREE_MIN
				? 0.6 + 0.4 * agreement
				: 0.5;
		// A net that reports its own uncertainty pulls the score down when it's unsure (no-op
		// until the model has an uncertainty head, when nc is null).
		if (nc !== null) base *= 0.6 + 0.4 * nc;
		return { corners: net.corners, source: "net", base, agreement };
	}

	if (seg) {
		return {
			corners: seg.corners,
			source: "segmentation",
			base: seg.accepted ? 0.45 + 0.4 * segScore(seg.rectangularity) : 0.35,
			agreement,
		};
	}

	return null;
}

/**
 * Learned net + segmentation, reconciled ({@link reconcile}) and edge-refined to the true
 * boundary, returned with a confidence score. Falls back to the pure-TS band scan when neither
 * wasm detector loads. See the module doc for the rationale and {@link refineToEdges} for the
 * refinement.
 */
export async function detectSleeveCornersBest(
	img: RgbaImage,
): Promise<SleeveDetection | null> {
	const [net, seg] = await Promise.all([detectViaNet(img), detectViaSeg(img)]);

	let picked = reconcile(net, seg);
	if (!picked) {
		const ts = detectSleeveCorners(img);
		if (!ts) return null;
		picked = { corners: ts, source: "band-scan", base: 0.35, agreement: null };
	}

	const { corners, confidence: edgeConf } = refineToEdges(img, picked.corners);
	const edgeLock = edgeConf
		? edgeConf.filter((c) => c >= EDGE_CONFIDENCE_MIN).length / 4
		: 0;

	// Fold in whether the edges actually locked onto a boundary: all four found leaves the base
	// untouched (×1.0), none found knocks it to ×0.7 — a seed whose edges never snapped is worth
	// more scrutiny even if the detectors agreed on the region.
	const confidence = clamp01(picked.base * (0.7 + 0.3 * edgeLock));

	return {
		corners,
		confidence,
		source: picked.source,
		signals: {
			agreement: picked.agreement,
			segRectangularity: seg ? seg.rectangularity : null,
			segAccepted: seg?.accepted ?? false,
			netConfidence: net ? netConfidence(net.sigma) : null,
			edgeLock,
		},
	};
}
