import { Info, Loader2, Scan } from "lucide-react";
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
const NUDGE = 0.005; // arrow-key step, as a fraction of the image
const CORNER_GRAB_PX = 14; // press within this of a corner → grab just that corner
const EDGE_GRAB_PX = 12; // else within this of an edge → grab the whole edge
const LOUPE_SIZE = 132; // magnifier diameter, px
const LOUPE_ZOOM = 3; // magnification factor
const LOUPE_GAP = 20; // gap between the corner and the magnifier, px

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

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

/** Distance (px) from point P to segment AB, with the clamped projection parameter t. */
function segmentDistance(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): { dist: number; t: number } {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return { dist: Math.hypot(px - cx, py - cy), t };
}

type DragState =
	| { kind: "corner"; quad: QuadKey; index: number }
	| {
			kind: "edge";
			quad: QuadKey;
			a: number;
			b: number;
			startA: NormalizedCorner;
			startB: NormalizedCorner;
			originX: number;
			originY: number;
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
 * reports every move. Three ways to adjust:
 *  - drag a corner handle (either quad) to move it precisely;
 *  - drag an edge to slide its two corners together (rigidly);
 *  - click anywhere else to jump the nearest corner to that spot (then keep dragging it).
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
	/** Optional: run detection (server-side) and return suggested corners to seed. */
	onDetect?: () => Promise<NormalizedCorners | null>;
	disabled?: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [detecting, setDetecting] = useState(false);
	// Which handle the loupe magnifies — the hovered/focused one, or the one being
	// dragged. The rendered image box size, tracked so the magnifier can map
	// normalised corner coords to background pixels.
	const [hover, setHover] = useState<{ quad: QuadKey; index: number } | null>(
		null,
	);
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
				onChange(bandFromQuad(found));
				toast.success("Detected the sleeve — nudge the handles to fine-tune.");
			} else {
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

	const setCorner = (quad: QuadKey, index: number, point: NormalizedCorner) => {
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

	// Press anywhere on the image: decide whether the intent is a corner, an edge, or a
	// click-to-move (across BOTH quads — nearest wins), then start the matching drag
	// (all pointer moves flow to the container via pointer capture, so a fast drag never
	// outruns the handles).
	const onPointerDown = (e: React.PointerEvent) => {
		if (disabled) return;
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect) return;
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

		// Nearest edge across both quads (distance to the segment, so a click past an
		// endpoint doesn't count).
		let edge: { quad: QuadKey; index: number } = { quad: "outer", index: 0 };
		let edgeDist = Number.POSITIVE_INFINITY;
		for (const quad of QUADS) {
			const p = pts(quad);
			EDGES.forEach(([a, b], k) => {
				const { dist } = segmentDistance(
					px,
					py,
					p[a][0],
					p[a][1],
					p[b][0],
					p[b][1],
				);
				if (dist < edgeDist) {
					edgeDist = dist;
					edge = { quad, index: k };
				}
			});
		}

		e.preventDefault();
		containerRef.current?.setPointerCapture(e.pointerId);

		if (cornerDist <= CORNER_GRAB_PX) {
			// Grab the corner in place — don't jump it to the (slightly-off) press point.
			setDrag({ kind: "corner", quad: corner.quad, index: corner.index });
		} else if (edgeDist <= EDGE_GRAB_PX) {
			const [a, b] = EDGES[edge.index];
			setDrag({
				kind: "edge",
				quad: edge.quad,
				a,
				b,
				startA: value[edge.quad][a],
				startB: value[edge.quad][b],
				originX: e.clientX,
				originY: e.clientY,
			});
		} else {
			// Open space: jump the nearest corner here, then keep dragging it.
			setCorner(corner.quad, corner.index, pointerToNorm(e.clientX, e.clientY));
			setDrag({ kind: "corner", quad: corner.quad, index: corner.index });
		}
	};

	const onPointerMove = (e: React.PointerEvent) => {
		if (!drag) return;
		if (drag.kind === "corner") {
			setCorner(drag.quad, drag.index, pointerToNorm(e.clientX, e.clientY));
			return;
		}
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect) return;
		// Translate both endpoints by the same delta, clamped so neither leaves the frame —
		// keeping the edge rigid rather than letting one corner stick at a wall.
		let dx = (e.clientX - drag.originX) / rect.width;
		let dy = (e.clientY - drag.originY) / rect.height;
		dx = Math.min(
			Math.min(1 - drag.startA[0], 1 - drag.startB[0]),
			Math.max(Math.max(-drag.startA[0], -drag.startB[0]), dx),
		);
		dy = Math.min(
			Math.min(1 - drag.startA[1], 1 - drag.startB[1]),
			Math.max(Math.max(-drag.startA[1], -drag.startB[1]), dy),
		);
		const na: NormalizedCorner = [drag.startA[0] + dx, drag.startA[1] + dy];
		const nb: NormalizedCorner = [drag.startB[0] + dx, drag.startB[1] + dy];
		onChange({
			...value,
			[drag.quad]: value[drag.quad].map((c, i) =>
				i === drag.a ? na : i === drag.b ? nb : c,
			) as NormalizedCorners,
		});
	};

	const endDrag = (e: React.PointerEvent) => {
		containerRef.current?.releasePointerCapture?.(e.pointerId);
		setDrag(null);
	};

	const isActive = (quad: QuadKey, i: number) =>
		drag?.kind === "corner"
			? drag.quad === quad && drag.index === i
			: drag?.kind === "edge" &&
				drag.quad === quad &&
				(drag.a === i || drag.b === i);

	// SVG polygon points in a 0..100 viewBox (preserveAspectRatio none → stretches to
	// the image box); a non-scaling stroke keeps the outlines crisp despite the stretch.
	const polyPoints = (quad: QuadKey) =>
		value[quad].map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

	// Show the magnifier for the corner being dragged, else the hovered/focused one.
	const loupe = drag?.kind === "corner" ? drag : hover;

	return (
		<div className="space-y-2">
			{/* Wrapper (no clip) so the magnifier can float past the image's edges. */}
			<div className="relative">
				<div
					ref={containerRef}
					className={cn(
						"relative overflow-hidden rounded-md border bg-muted select-none touch-none",
						!disabled && "cursor-crosshair",
					)}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
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
								disabled={disabled}
								className={cn(
									"absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-background shadow",
									"focus-visible:outline-none focus-visible:ring-2",
									quad === "outer"
										? "size-3.5 border-brand focus-visible:ring-brand"
										: "size-3 border-sky-400 focus-visible:ring-sky-400",
									isActive(quad, i) &&
										(quad === "outer"
											? "ring-2 ring-brand"
											: "ring-2 ring-sky-400"),
									disabled ? "cursor-not-allowed opacity-50" : "cursor-grab",
								)}
								style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
								onPointerEnter={() => setHover({ quad, index: i })}
								onPointerLeave={() =>
									setHover((h) =>
										h?.quad === quad && h.index === i ? null : h,
									)
								}
								onKeyDown={(e) => {
									const d: Record<string, NormalizedCorner> = {
										ArrowLeft: [-NUDGE, 0],
										ArrowRight: [NUDGE, 0],
										ArrowUp: [0, -NUDGE],
										ArrowDown: [0, NUDGE],
									};
									const step = d[e.key];
									if (!step) return;
									e.preventDefault();
									setCorner(quad, i, [
										clamp01(x + step[0]),
										clamp01(y + step[1]),
									]);
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
	);
}
