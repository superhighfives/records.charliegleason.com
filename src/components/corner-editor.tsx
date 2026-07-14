import { Loader2, Scan } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import type { NormalizedCorner, NormalizedCorners } from "#/lib/sleeve-corners";
import { cn } from "#/lib/utils";

const CORNER_LABELS = ["Top-left", "Top-right", "Bottom-right", "Bottom-left"];
// The four sleeve edges, as index pairs into the TL,TR,BR,BL corner list.
const EDGES: Array<[number, number]> = [
	[0, 1],
	[1, 2],
	[2, 3],
	[3, 0],
];
const NUDGE = 0.005; // arrow-key step, as a fraction of the image
const CORNER_GRAB_PX = 20; // press within this of a corner → grab just that corner
const EDGE_GRAB_PX = 16; // else within this of an edge → grab the whole edge

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

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
	| { kind: "corner"; index: number }
	| {
			kind: "edge";
			a: number;
			b: number;
			startA: NormalizedCorner;
			startB: NormalizedCorner;
			originX: number;
			originY: number;
	  };

/**
 * A draggable four-corner crop editor over the capture. The admin marks the sleeve's
 * corners; the parent turns those into a deterministic perspective-warp. Controlled:
 * `value` is the current {@link NormalizedCorners} (0..1, TL,TR,BR,BL) and `onChange`
 * reports every move. Three ways to adjust:
 *  - drag a corner handle to move it precisely;
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
	value: NormalizedCorners;
	onChange: (corners: NormalizedCorners) => void;
	/** Optional: run detection (server-side) and return suggested corners to seed. */
	onDetect?: () => Promise<NormalizedCorners | null>;
	disabled?: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [detecting, setDetecting] = useState(false);

	const runDetect = async () => {
		if (!onDetect) return;
		setDetecting(true);
		try {
			const found = await onDetect();
			if (found) {
				onChange(found);
				toast.success("Detected the sleeve — nudge the handles to fine-tune.");
			} else {
				toast.message("Couldn't find the sleeve automatically.", {
					description: "Drag the four corners to the edges of the sleeve.",
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

	const setCorner = (index: number, point: NormalizedCorner) => {
		onChange(
			value.map((c, i) => (i === index ? point : c)) as NormalizedCorners,
		);
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
	// click-to-move, then start the matching drag (all pointer moves flow to the container
	// via pointer capture, so a fast drag never outruns the handles).
	const onPointerDown = (e: React.PointerEvent) => {
		if (disabled) return;
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect) return;
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		const pts = value.map(
			([x, y]) => [x * rect.width, y * rect.height] as const,
		);

		// Nearest corner.
		let corner = 0;
		let cornerDist = Number.POSITIVE_INFINITY;
		pts.forEach(([x, y], i) => {
			const d = Math.hypot(px - x, py - y);
			if (d < cornerDist) {
				cornerDist = d;
				corner = i;
			}
		});

		// Nearest edge (distance to the segment, so a click past an endpoint doesn't count).
		let edge = 0;
		let edgeDist = Number.POSITIVE_INFINITY;
		EDGES.forEach(([a, b], k) => {
			const { dist } = segmentDistance(
				px,
				py,
				pts[a][0],
				pts[a][1],
				pts[b][0],
				pts[b][1],
			);
			if (dist < edgeDist) {
				edgeDist = dist;
				edge = k;
			}
		});

		e.preventDefault();
		containerRef.current?.setPointerCapture(e.pointerId);

		if (cornerDist <= CORNER_GRAB_PX) {
			// Grab the corner in place — don't jump it to the (slightly-off) press point.
			setDrag({ kind: "corner", index: corner });
		} else if (edgeDist <= EDGE_GRAB_PX) {
			const [a, b] = EDGES[edge];
			setDrag({
				kind: "edge",
				a,
				b,
				startA: value[a],
				startB: value[b],
				originX: e.clientX,
				originY: e.clientY,
			});
		} else {
			// Open space: jump the nearest corner here, then keep dragging it.
			setCorner(corner, pointerToNorm(e.clientX, e.clientY));
			setDrag({ kind: "corner", index: corner });
		}
	};

	const onPointerMove = (e: React.PointerEvent) => {
		if (!drag) return;
		if (drag.kind === "corner") {
			setCorner(drag.index, pointerToNorm(e.clientX, e.clientY));
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
		onChange(
			value.map((c, i) =>
				i === drag.a ? na : i === drag.b ? nb : c,
			) as NormalizedCorners,
		);
	};

	const endDrag = (e: React.PointerEvent) => {
		containerRef.current?.releasePointerCapture?.(e.pointerId);
		setDrag(null);
	};

	const isActive = (i: number) =>
		drag?.kind === "corner"
			? drag.index === i
			: drag?.kind === "edge" && (drag.a === i || drag.b === i);

	// SVG polygon points in a 0..100 viewBox (preserveAspectRatio none → stretches to
	// the image box); a non-scaling stroke keeps the outline crisp despite the stretch.
	const polyPoints = value.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

	return (
		<div className="space-y-2">
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
					<polygon
						points={polyPoints}
						className="fill-brand/10 stroke-brand"
						strokeWidth={2}
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
				{value.map(([x, y], i) => (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed 4 corners, order is stable
						key={i}
						type="button"
						aria-label={`${CORNER_LABELS[i]} corner`}
						disabled={disabled}
						className={cn(
							"absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand bg-background shadow",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
							isActive(i) && "ring-2 ring-brand",
							disabled ? "cursor-not-allowed opacity-50" : "cursor-grab",
						)}
						style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
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
							setCorner(i, [clamp01(x + step[0]), clamp01(y + step[1])]);
						}}
					/>
				))}
			</div>
			<div className="flex items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">
					Drag a corner or edge, or click to move the nearest corner.
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
