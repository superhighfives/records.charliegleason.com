import { Loader2, Scan } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import type { NormalizedCorner, NormalizedCorners } from "#/lib/sleeve-corners";
import { cn } from "#/lib/utils";

const CORNER_LABELS = ["Top-left", "Top-right", "Bottom-right", "Bottom-left"];
const NUDGE = 0.005; // arrow-key step, as a fraction of the image

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A draggable four-corner crop editor over the capture. The admin drags the handles to
 * the sleeve's corners; the parent turns those corners into a deterministic
 * perspective-warp. Controlled: `value` is the current {@link NormalizedCorners} (0..1,
 * TL,TR,BR,BL) and `onChange` reports every move.
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
	const [drag, setDrag] = useState<number | null>(null);
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

	// SVG polygon points in a 0..100 viewBox (preserveAspectRatio none → stretches to
	// the image box); a non-scaling stroke keeps the outline crisp despite the stretch.
	const polyPoints = value.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

	return (
		<div className="space-y-2">
			<div
				ref={containerRef}
				className="relative overflow-hidden rounded-md border bg-muted select-none touch-none"
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
							drag === i && "ring-2 ring-brand",
							disabled && "cursor-not-allowed opacity-50",
						)}
						style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
						onPointerDown={(e) => {
							if (disabled) return;
							e.preventDefault();
							e.currentTarget.setPointerCapture(e.pointerId);
							setDrag(i);
						}}
						onPointerMove={(e) => {
							if (drag !== i) return;
							setCorner(i, pointerToNorm(e.clientX, e.clientY));
						}}
						onPointerUp={(e) => {
							e.currentTarget.releasePointerCapture?.(e.pointerId);
							setDrag(null);
						}}
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
					Drag the corners to the edges of the sleeve.
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
