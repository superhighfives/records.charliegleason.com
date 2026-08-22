import { Info, Loader2, Magnet, Scan } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "#/components/ui/tooltip";
import {
	type Corners,
	EDGE_CONFIDENCE_MIN,
	type EdgeConfidence,
	edgeDistances,
	midQuad,
	type RgbaImage,
	refineQuadEdgesDetailed,
} from "#/lib/photo-processing";
import {
	bandFromQuad,
	type CornerBand,
	isBandValid,
	type NormalizedCorner,
	type NormalizedCorners,
} from "#/lib/sleeve-corners";
// Type-only: the detection object shape. Importing the value module would pull its dynamic
// wasm imports into the client bundle; the types erase at compile time, so this stays free.
import type {
	DetectionSource,
	SleeveDetection,
} from "#/lib/sleeve-detect-wasm";
import { cn } from "#/lib/utils";

const CORNER_LABELS = ["Top-left", "Top-right", "Bottom-right", "Bottom-left"];
// The four sleeve edges, as index pairs into the TL,TR,BR,BL corner list.
const EDGES: Array<[number, number]> = [
	[0, 1],
	[1, 2],
	[2, 3],
	[3, 0],
];
// The two quads of the corner band, with their editor affordances. The OUTER quad is
// drawn wholly on the background (everything beyond it is certified background); the
// INNER quad wholly on the sleeve (everything within it is certified sleeve). The true
// edge lies in the band between — the dashed overlay shows where the cut will find it.
const QUADS = ["outer", "inner"] as const;
type QuadKey = (typeof QUADS)[number];
const NUDGE = 0.0005; // arrow-key step, as a fraction of the image (~1px at 2048px)
const COARSE_NUDGE_MULTIPLIER = 10; // Shift+arrow jumps ~10px instead of ~1px
const CORNER_GRAB_PX = 14; // press within this of a corner → grab just that corner
const CLICK_MOVE_THRESHOLD_PX = 4; // pointer moved less than this → treat as a click, not a drag
const LOUPE_SIZE = 132; // magnifier diameter, px
const LOUPE_ZOOM = 3; // magnification factor
const LOUPE_GAP = 20; // gap between the corner and the magnifier, px
const KEYBOARD_LOUPE_HOLD_MS = 2000; // how long the loupe stays up after an arrow-key nudge

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Human-readable name for whichever detector produced the seed (see SleeveDetection.source).
const DETECTION_SOURCE_LABEL: Record<DetectionSource, string> = {
	net: "learned detector",
	segmentation: "colour segmentation",
	"segmentation-override": "colour segmentation",
	"band-scan": "edge scan",
};

/**
 * Map a detection to the badge shown under the editor: a colour band, a percentage, and — for
 * the cases worth a closer look (a detector disagreement or a low score) — a one-line nudge to
 * scrutinise. The admin always reviews the seed; this just says how hard to look. Bands match
 * {@link confidenceBand} in sleeve-detect-wasm.
 */
function detectionBadge(d: SleeveDetection): {
	dot: string;
	text: string;
	scrutinise: string | null;
} {
	const pct = Math.round(d.confidence * 100);
	const band =
		d.confidence >= 0.75 ? "high" : d.confidence >= 0.45 ? "medium" : "low";
	const dot =
		band === "high"
			? "bg-emerald-500"
			: band === "medium"
				? "bg-amber-500"
				: "bg-red-500";
	const source = DETECTION_SOURCE_LABEL[d.source];
	if (d.source === "segmentation-override") {
		return {
			dot: "bg-amber-500",
			text: `${pct}% · ${source} (detectors disagreed)`,
			scrutinise:
				"The learned detector looked out of its depth, so this used the colour outline — give it a careful look.",
		};
	}
	return {
		dot,
		text: `${pct}% confidence · ${source}`,
		scrutinise:
			band === "low"
				? "Low confidence — check the handles before applying."
				: null,
	};
}

// The refined-edge overlay runs the same edge search the server does, on a small
// decode of the capture — big enough that the sleeve edge survives downscaling,
// small enough to re-run on every corner move without jank.
const REFINE_SOURCE_MAX = 800;

/** Decode an image URL to RGBA, downscaled so its longest side ≤ `max`. */
async function decodeDownscaled(src: string, max: number): Promise<RgbaImage> {
	const img = new Image();
	img.src = src; // same-origin (/api/photos/…), so the canvas is never tainted
	await img.decode();
	const scale = Math.min(
		1,
		max / Math.max(img.naturalWidth, img.naturalHeight),
	);
	const w = Math.max(1, Math.round(img.naturalWidth * scale));
	const h = Math.max(1, Math.round(img.naturalHeight * scale));
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("no 2d context");
	ctx.drawImage(img, 0, 0, w, h);
	const { data } = ctx.getImageData(0, 0, w, h);
	return { data, width: w, height: h };
}

// Key identifying one of the eight corner handles (four per quad), for selection.
const cornerKey = (quad: QuadKey, index: number) => `${quad}:${index}`;
const isQuadKey = (value: string): value is QuadKey =>
	(QUADS as readonly string[]).includes(value);
const parseCornerKey = (key: string): { quad: QuadKey; index: number } => {
	const [quad, index] = key.split(":");
	if (!isQuadKey(quad)) throw new Error(`invalid corner key: ${key}`);
	return { quad, index: Number(index) };
};

type DragState = {
	quad: QuadKey;
	index: number;
	startClientX: number;
	startClientY: number;
};

/**
 * The magnifier loupe: a circular, 3× zoom of the capture centred on `point`
 * (normalised 0..1), floated above (or below) the corner with a crosshair marking
 * the exact spot. The background always centres the point, so the crosshair at the
 * loupe's centre tracks the corner regardless of where the loupe is clamped on screen.
 */
function Loupe({
	src,
	point,
	box,
}: {
	src: string;
	point: NormalizedCorner;
	box: { w: number; h: number };
}) {
	const [x, y] = point;
	const bgW = box.w * LOUPE_ZOOM;
	const bgH = box.h * LOUPE_ZOOM;
	// Keep the loupe within the image's width; the point stays centred regardless.
	const maxLeft = Math.max(6, box.w - LOUPE_SIZE - 6);
	const left = Math.min(Math.max(x * box.w - LOUPE_SIZE / 2, 6), maxLeft);
	// Prefer above the corner; drop below when there isn't room up top.
	const above = y * box.h - LOUPE_SIZE - LOUPE_GAP >= 6;
	const top = above
		? y * box.h - LOUPE_SIZE - LOUPE_GAP
		: y * box.h + LOUPE_GAP;

	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute z-20 overflow-hidden rounded-full border-2 border-brand bg-muted shadow-lg"
			style={{
				width: LOUPE_SIZE,
				height: LOUPE_SIZE,
				left,
				top,
				backgroundImage: `url(${src})`,
				backgroundRepeat: "no-repeat",
				backgroundSize: `${bgW}px ${bgH}px`,
				backgroundPosition: `${LOUPE_SIZE / 2 - x * bgW}px ${LOUPE_SIZE / 2 - y * bgH}px`,
			}}
		>
			<span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-brand/70" />
			<span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-brand/70" />
			<span className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand" />
		</div>
	);
}

/**
 * A draggable corner-BAND editor over the capture: two nested quads bracketing the
 * sleeve's true edge. The admin drags the OUTER quad (brand-coloured) so it sits wholly
 * on the background just past the sleeve, and the INNER quad (sky-coloured) so it sits
 * wholly on the sleeve just inside the edge — the band between is the matting trimap's
 * unknown region, and the dashed overlay shows where the edge search will actually cut
 * inside it. Controlled: `value` is the current {@link CornerBand} and `onChange`
 * reports every move. Ways to adjust:
 *  - drag a corner handle (either quad) to move it precisely;
 *  - click anywhere else to jump the nearest corner to that spot (then keep dragging it);
 *  - click a handle (without moving) to select it, shift-click to add/remove from the
 *    selection, then nudge every selected handle with the arrow keys; Escape deselects.
 */
export function CornerEditor({
	src,
	value,
	onChange,
	onDetect,
	disabled,
}: {
	src: string;
	value: CornerBand;
	onChange: (band: CornerBand) => void;
	/** Optional: run detection (server-side) and return the suggested corners plus a
	 *  confidence score / source to seed and badge. */
	onDetect?: () => Promise<SleeveDetection | null>;
	disabled?: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	// True while a pointer interaction is in flight, so the focus event a mouse
	// click fires on pointerdown doesn't collapse the selection before endDrag's
	// shift-click logic runs against it.
	const pointerInteractionRef = useRef(false);
	const [drag, setDrag] = useState<DragState | null>(null);
	// The set of handles selected for keyboard nudging, keyed by `${quad}:${index}`.
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [detecting, setDetecting] = useState(false);
	// The last detection result, kept so its confidence badge persists under the editor after
	// the toast fades — cleared once the admin edits a handle (the seed is no longer "the
	// detection"). Never gates anything: the admin reviews every seed regardless.
	const [detection, setDetection] = useState<SleeveDetection | null>(null);
	// Which handle the loupe magnifies — the hovered/focused one, or the one being
	// dragged. The rendered image box size, tracked so the magnifier can map
	// normalised corner coords to background pixels.
	const [hover, setHover] = useState<{ quad: QuadKey; index: number } | null>(
		null,
	);
	// Shows the loupe over the last arrow-key-nudged handle for a couple of seconds
	// after the keys stop, so it stays up even once the mouse (which isn't over the
	// handle during keyboard nudging) is what would otherwise clear `hover`.
	const [keyboardLoupe, setKeyboardLoupe] = useState<{
		quad: QuadKey;
		index: number;
	} | null>(null);
	const keyboardLoupeTimeoutRef = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (keyboardLoupeTimeoutRef.current != null)
				window.clearTimeout(keyboardLoupeTimeoutRef.current);
		};
	}, []);
	// Drops a stale keyboard-nudge loupe whenever selection changes for a reason
	// other than the nudge itself (tabbing or clicking to a different handle).
	const clearKeyboardLoupe = () => {
		setKeyboardLoupe(null);
		if (keyboardLoupeTimeoutRef.current != null) {
			window.clearTimeout(keyboardLoupeTimeoutRef.current);
			keyboardLoupeTimeoutRef.current = null;
		}
	};
	const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
	// The refined-edge overlay: where the server's edge search will snap each edge
	// inside the band, and how confident it is per edge — so a disagreement (or an
	// amber no-boundary edge) is visible *before* Apply, not a minute after.
	const [refineSource, setRefineSource] = useState<RgbaImage | null>(null);
	const [refined, setRefined] = useState<{
		corners: NormalizedCorners;
		confidence: EdgeConfidence;
	} | null>(null);
	const refineRafRef = useRef<number | null>(null);

	const bandValid = isBandValid(value);

	useEffect(() => {
		let cancelled = false;
		setRefineSource(null);
		setRefined(null);
		decodeDownscaled(src, REFINE_SOURCE_MAX)
			.then((rgba) => {
				if (!cancelled) setRefineSource(rgba);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [src]);

	// Re-run the edge search whenever the band moves — coalesced to one animation
	// frame so a fast drag doesn't queue a search per pointer event. The search runs
	// from the band midline, bounded per edge by the inner/outer quads — exactly the
	// server's cut. `value` is safe as a whole-object dependency here: the caller
	// holds it in `useState` and only replaces it (via `onChange`) when the band
	// actually moves, so its identity doesn't change on unrelated re-renders —
	// unlike a prop rebuilt as a fresh literal every render, which would need
	// narrowing to primitive fields to avoid spurious re-runs.
	useEffect(() => {
		if (!refineSource || !bandValid) {
			if (!bandValid) setRefined(null);
			return;
		}
		if (refineRafRef.current) cancelAnimationFrame(refineRafRef.current);
		refineRafRef.current = requestAnimationFrame(() => {
			const { width, height } = refineSource;
			const toPx = (quad: NormalizedCorners) =>
				quad.map(([x, y]) => [x * (width - 1), y * (height - 1)]) as Corners;
			const innerPx = toPx(value.inner);
			const outerPx = toPx(value.outer);
			const mid = midQuad(innerPx, outerPx);
			const result = refineQuadEdgesDetailed(refineSource, mid, {
				outward: edgeDistances(mid, outerPx),
				inward: edgeDistances(mid, innerPx),
				minConfidence: EDGE_CONFIDENCE_MIN,
			});
			setRefined({
				corners: result.corners.map(([x, y]) => [
					clamp01(x / (width - 1)),
					clamp01(y / (height - 1)),
				]) as NormalizedCorners,
				confidence: result.confidence,
			});
		});
		return () => {
			if (refineRafRef.current) cancelAnimationFrame(refineRafRef.current);
		};
	}, [refineSource, value, bandValid]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const runDetect = async () => {
		if (!onDetect) return;
		setDetecting(true);
		try {
			const found = await onDetect();
			if (found) {
				// The detector returns a single quad on the edge — seed the band around it.
				onChange(bandFromQuad(found.corners));
				setDetection(found);
				if (found.source === "segmentation-override") {
					toast.warning("Detectors disagreed — used the colour outline.", {
						description:
							"The learned detector looked out of its depth. Give the seed a careful look.",
					});
				} else if (found.confidence < 0.45) {
					toast.message("Detected the sleeve, but low confidence.", {
						description: "Check the handles carefully before applying.",
					});
				} else {
					toast.success(
						"Detected the sleeve — nudge the handles to fine-tune.",
					);
				}
			} else {
				setDetection(null);
				toast.message("Couldn't find the sleeve automatically.", {
					description:
						"Drag the outer handles onto the background and the inner ones onto the sleeve.",
				});
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't detect the sleeve.",
			);
		} finally {
			setDetecting(false);
		}
	};

	// Commit the live edge-refinement (the dashed overlay) as the band: drag the handles
	// roughly onto the sleeve, then snap the whole band to where the edge search actually
	// found the boundary. Only the edges the search was confident about move — an amber
	// (no-boundary) edge keeps the admin's line — so this never yanks a hand-placed edge
	// off a genuinely ambiguous boundary.
	const snapToEdges = () => {
		if (disabled || !refined) return;
		setDetection(null);
		onChange(bandFromQuad(refined.corners));
		toast.success("Snapped the band to the detected edges.");
	};

	const setCorner = (quad: QuadKey, index: number, point: NormalizedCorner) => {
		setDetection(null);
		onChange({
			...value,
			[quad]: value[quad].map((c, i) =>
				i === index ? point : c,
			) as NormalizedCorners,
		});
	};

	const pointerToNorm = (
		clientX: number,
		clientY: number,
	): NormalizedCorner => {
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect) return [0, 0];
		return [
			clamp01((clientX - rect.left) / rect.width),
			clamp01((clientY - rect.top) / rect.height),
		];
	};

	// Nudge every selected handle by the same delta, clamped per-corner to the frame.
	const moveSelected = (dx: number, dy: number) => {
		if (disabled || selected.size === 0) return;
		setDetection(null);
		const next = { ...value };
		for (const quad of QUADS) {
			next[quad] = value[quad].map((c, i) =>
				selected.has(cornerKey(quad, i))
					? ([clamp01(c[0] + dx), clamp01(c[1] + dy)] as NormalizedCorner)
					: c,
			) as NormalizedCorners;
		}
		onChange(next);

		// Surface the loupe over one of the just-nudged handles for a couple of
		// seconds, refreshed on every keypress, so the admin can see where the
		// corner landed without having to hover it.
		const firstKey = selected.values().next().value;
		if (firstKey) {
			setKeyboardLoupe(parseCornerKey(firstKey));
			if (keyboardLoupeTimeoutRef.current != null)
				window.clearTimeout(keyboardLoupeTimeoutRef.current);
			keyboardLoupeTimeoutRef.current = window.setTimeout(() => {
				setKeyboardLoupe(null);
			}, KEYBOARD_LOUPE_HOLD_MS);
		}
	};

	// Press anywhere on the image: decide whether the intent is a corner drag or a
	// click-to-move (nearest corner across BOTH quads wins), then grab that corner
	// (all pointer moves flow to the container via pointer capture, so a fast drag never
	// outruns the handles). Whether this turns into a selection or a drag is decided on
	// release, based on how far the pointer actually travelled.
	const onPointerDown = (e: React.PointerEvent) => {
		if (disabled) return;
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect) return;
		pointerInteractionRef.current = true;
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		const pts = (quad: QuadKey) =>
			value[quad].map(([x, y]) => [x * rect.width, y * rect.height] as const);

		// Nearest corner across both quads.
		let corner: { quad: QuadKey; index: number } = { quad: "outer", index: 0 };
		let cornerDist = Number.POSITIVE_INFINITY;
		for (const quad of QUADS) {
			pts(quad).forEach(([x, y], i) => {
				const d = Math.hypot(px - x, py - y);
				if (d < cornerDist) {
					cornerDist = d;
					corner = { quad, index: i };
				}
			});
		}

		e.preventDefault();
		containerRef.current?.setPointerCapture(e.pointerId);

		if (cornerDist > CORNER_GRAB_PX) {
			// Open space: jump the nearest corner here, then keep dragging it.
			setCorner(corner.quad, corner.index, pointerToNorm(e.clientX, e.clientY));
		}
		setDrag({
			quad: corner.quad,
			index: corner.index,
			startClientX: e.clientX,
			startClientY: e.clientY,
		});
	};

	const onPointerMove = (e: React.PointerEvent) => {
		if (!drag) return;
		setCorner(drag.quad, drag.index, pointerToNorm(e.clientX, e.clientY));
	};

	const endDrag = (e: React.PointerEvent) => {
		containerRef.current?.releasePointerCapture?.(e.pointerId);
		if (drag) {
			const key = cornerKey(drag.quad, drag.index);
			const moved =
				Math.hypot(
					e.clientX - drag.startClientX,
					e.clientY - drag.startClientY,
				) > CLICK_MOVE_THRESHOLD_PX;
			// Plain click or drag: this handle becomes the sole selection. If it
			// wasn't already the only selected handle, drop any stale nudge loupe
			// still pointing at whatever was selected before. Computed against
			// `selected` (not inside the setSelected updater) since updaters can
			// run twice under StrictMode and the clear isn't guaranteed idempotent
			// forever.
			if (!e.shiftKey && !(selected.size === 1 && selected.has(key)))
				clearKeyboardLoupe();
			setSelected((prev) => {
				if (e.shiftKey) {
					const next = new Set(prev);
					if (moved) {
						// Dragged with shift held: add to the selection, keep the rest.
						next.add(key);
					} else if (next.has(key)) {
						next.delete(key);
					} else {
						next.add(key);
					}
					return next;
				}
				return new Set([key]);
			});
			// Focus the container (not the button — Safari doesn't focus buttons on
			// click) so the arrow-key/Escape handler below actually receives the keys.
			containerRef.current?.focus();
		}
		pointerInteractionRef.current = false;
		setDrag(null);
	};

	const onContainerKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			if (selected.size === 0) return;
			e.preventDefault();
			setSelected(new Set());
			return;
		}
		const s = e.shiftKey ? NUDGE * COARSE_NUDGE_MULTIPLIER : NUDGE;
		const step: Record<string, NormalizedCorner> = {
			ArrowLeft: [-s, 0],
			ArrowRight: [s, 0],
			ArrowUp: [0, -s],
			ArrowDown: [0, s],
		};
		const delta = step[e.key];
		if (!delta || selected.size === 0) return;
		e.preventDefault();
		moveSelected(delta[0], delta[1]);
	};

	const isActive = (quad: QuadKey, i: number) =>
		drag?.quad === quad && drag.index === i;
	const isSelected = (quad: QuadKey, i: number) =>
		selected.has(cornerKey(quad, i));

	// SVG polygon points in a 0..100 viewBox (preserveAspectRatio none → stretches to
	// the image box); a non-scaling stroke keeps the outlines crisp despite the stretch.
	const polyPoints = (quad: QuadKey) =>
		value[quad].map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

	// Show the magnifier for the corner being dragged, else the hovered/focused
	// one, else a just-nudged handle (kept up briefly so it survives the mouse
	// not being over the handle during keyboard nudging).
	const loupe = drag ?? hover ?? keyboardLoupe;

	return (
		<div className="space-y-2">
			{/* Wrapper (no clip) so the magnifier can float past the image's edges. */}
			<div className="relative">
				{/* biome-ignore lint/a11y/noStaticElementInteractions: custom drag/select
				    canvas — the handles inside are the real interactive controls; this div
				    only relays pointer capture and hosts the arrow-key/Escape handler for
				    whichever handles are selected. */}
				<div
					ref={containerRef}
					tabIndex={-1}
					className={cn(
						"relative overflow-hidden rounded-md border bg-muted select-none touch-none",
						"focus:outline-none",
						!disabled && "cursor-crosshair",
					)}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
					onKeyDown={onContainerKeyDown}
				>
					<img
						src={src}
						alt="Capture"
						className="block w-full"
						draggable={false}
					/>
					<svg
						className="pointer-events-none absolute inset-0 h-full w-full"
						viewBox="0 0 100 100"
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						{/* Outer quad: wholly on the background — everything beyond it is
						    certified background. */}
						<polygon
							points={polyPoints("outer")}
							className={cn(
								"fill-brand/10",
								bandValid ? "stroke-brand" : "stroke-red-500",
							)}
							strokeWidth={2}
							vectorEffect="non-scaling-stroke"
						/>
						{/* Inner quad: wholly on the sleeve — everything within it is
						    certified sleeve. The band between the two is the unknown region
						    the cut is resolved in. */}
						<polygon
							points={polyPoints("inner")}
							className={cn(
								"fill-transparent",
								bandValid ? "stroke-sky-400" : "stroke-red-500",
							)}
							strokeWidth={1.5}
							vectorEffect="non-scaling-stroke"
						/>
						{/* Where the edge search will actually cut, inside the band: dashed,
						    per edge. Emerald = a clear boundary was found; amber = no clear
						    boundary (that edge will cut straight along the band midline —
						    tighten the band around the true edge there). */}
						{refined &&
							!disabled &&
							EDGES.map(([a, b], e) => (
								<line
									// biome-ignore lint/suspicious/noArrayIndexKey: fixed 4 edges, order is stable
									key={e}
									x1={refined.corners[a][0] * 100}
									y1={refined.corners[a][1] * 100}
									x2={refined.corners[b][0] * 100}
									y2={refined.corners[b][1] * 100}
									className={
										refined.confidence[e] >= EDGE_CONFIDENCE_MIN
											? "stroke-emerald-400"
											: "stroke-amber-400"
									}
									strokeWidth={1.5}
									strokeDasharray="6 4"
									vectorEffect="non-scaling-stroke"
								/>
							))}
					</svg>
					{QUADS.map((quad) =>
						value[quad].map(([x, y], i) => (
							<button
								key={`${quad}-${CORNER_LABELS[i]}`}
								type="button"
								aria-label={`${CORNER_LABELS[i]} ${quad} corner`}
								aria-pressed={isSelected(quad, i)}
								disabled={disabled}
								className={cn(
									"absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-background shadow",
									"focus-visible:outline-none focus-visible:ring-2",
									quad === "outer"
										? "size-3.5 border-brand focus-visible:ring-brand"
										: "size-3 border-sky-400 focus-visible:ring-sky-400",
									(isActive(quad, i) || isSelected(quad, i)) &&
										(quad === "outer"
											? "border-brand bg-brand ring-2 ring-brand ring-offset-1"
											: "border-sky-400 bg-sky-400 ring-2 ring-sky-400 ring-offset-1"),
									disabled ? "cursor-not-allowed opacity-50" : "cursor-grab",
								)}
								style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
								onPointerEnter={() => setHover({ quad, index: i })}
								onPointerLeave={() =>
									setHover((h) =>
										h?.quad === quad && h.index === i ? null : h,
									)
								}
								onFocus={() => {
									// Skip focus from a pointer interaction — endDrag's shift-click
									// logic owns selection for that case; only a real Tab focus
									// (no pointer in flight) should select on its own.
									if (pointerInteractionRef.current) return;
									setSelected(new Set([cornerKey(quad, i)]));
									// Tabbing to a different handle without nudging it should drop
									// the previous handle's just-nudged loupe, not leave it pointing
									// at a corner that's no longer selected.
									clearKeyboardLoupe();
								}}
							/>
						)),
					)}
				</div>
				{/* Magnifier: a 3× loupe of the capture centred on the active corner, with a
			    crosshair marking the exact point — so a corner can be placed precisely
			    even though the handle itself sits under the finger/cursor. Purely visual
			    (pointer-events-none); the handle beneath still drives the drag. */}
				{loupe != null && box.w > 0 && !disabled && (
					<Loupe src={src} point={value[loupe.quad][loupe.index]} box={box} />
				)}
			</div>
			{!bandValid && (
				<p className="text-xs text-red-600 dark:text-red-400" role="alert">
					The inner (blue) corners must all sit inside the outer frame — fix the
					crossed handles before applying.
				</p>
			)}
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">
					Outer handles on the background, inner on the sleeve.
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="ml-1 inline-flex cursor-help align-middle text-muted-foreground hover:text-foreground">
								<Info
									className="size-3.5"
									aria-label="About the corner band and detected-edge overlay"
								/>
							</span>
						</TooltipTrigger>
						<TooltipContent align="start" className="max-w-xs text-xs">
							Two frames bracket the sleeve's true edge: the outer sits wholly
							on the background, the inner wholly on the sleeve (it's also the
							exact crop the square cover uses). The dashed line is the detected
							edge in between — <span className="text-emerald-500">green</span>{" "}
							found a clear boundary,{" "}
							<span className="text-amber-500">amber</span> didn't (that edge
							cuts straight midway through the band).
						</TooltipContent>
					</Tooltip>
				</p>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={disabled || !refined}
						onClick={snapToEdges}
						title="Snap the band to the detected edges"
					>
						<Magnet className="size-4" />
						Snap to edges
					</Button>
					{onDetect && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={disabled || detecting}
							onClick={runDetect}
						>
							{detecting ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Scan className="size-4" />
							)}
							{detecting ? "Detecting…" : "Detect corners"}
						</Button>
					)}
				</div>
			</div>
			{detection &&
				(() => {
					const badge = detectionBadge(detection);
					return (
						<div className="space-y-0.5">
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<span
									className={cn("size-2 shrink-0 rounded-full", badge.dot)}
									aria-hidden
								/>
								<span>{badge.text}</span>
							</div>
							{badge.scrutinise && (
								<p className="text-xs text-amber-600 dark:text-amber-400">
									{badge.scrutinise}
								</p>
							)}
						</div>
					);
				})()}
		</div>
	);
}
