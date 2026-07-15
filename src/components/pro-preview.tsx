import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
	applyPolish,
	type Corners,
	type MatteOptions,
	matteFromCorners,
	type RgbaImage,
	reframeFromCorners,
} from "#/lib/photo-processing";
import {
	DEFAULT_REFRAME_PARAMS,
	matteToneFromParams,
	type ReframeParams,
} from "#/lib/reframe-params";
import type { NormalizedCorners } from "#/lib/sleeve-corners";
import { cn } from "#/lib/utils";

/**
 * A live, client-side preview of the professional-photo reframe. Runs the *same*
 * pure pixel math the server does ({@link reframeFromCorners} — warp + crop + the
 * foreground-aware auto-tone), on a canvas, re-rendering as the corners and tone
 * knobs change — so the admin sees the result while dragging, not only after Apply.
 *
 * Two deliberate approximations vs the server's authoritative render (`Apply`):
 *  - the polish factors (saturation/contrast/gamma) run through the *same* {@link
 *    applyPolish} the server uses, so they match; there's just no final sharpen here.
 *    Apply still produces the real, stored image.
 *  - it renders at a small {@link PREVIEW_SIZE} from a downscaled capture, to stay smooth
 *    on the main thread while dragging.
 */

// Preview render resolution — small enough to warp per animation frame on the main thread.
const PREVIEW_SIZE = 448;
// The matte's transparent margin (fraction per side) — mirrors the server's 4%.
const MATTE_MARGIN = 0.04;
// Cap the decoded capture's longest side so warp sampling stays cheap (corners are
// normalised, so a downscaled source maps identically).
const SOURCE_MAX = 1100;

/** Decode an image URL to an {@link RgbaImage}, downscaled so its longest side ≤ SOURCE_MAX. */
async function decodeToRgba(src: string): Promise<RgbaImage> {
	const img = new Image();
	img.src = src; // same-origin (/api/photos/…), so the canvas is never tainted
	await img.decode();
	const scale = Math.min(
		1,
		SOURCE_MAX / Math.max(img.naturalWidth, img.naturalHeight),
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

export function ProPreview({
	src,
	corners,
	params,
	matte = false,
	className,
}: {
	src: string;
	corners: NormalizedCorners;
	params: ReframeParams;
	/** Render the transparent, true-edged matte (shadow variant) on a checkerboard,
	 *  rather than the square hero. Runs the *deterministic* silhouette client-side —
	 *  the paid matting path isn't client-runnable, so (like Enhance) it only appears
	 *  after Apply, via the hover-reveal of the stored image. */
	matte?: boolean;
	className?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rafRef = useRef<number | null>(null);
	const [source, setSource] = useState<RgbaImage | null>(null);

	// Decode the capture once per src (cheap, cached by the browser image cache).
	useEffect(() => {
		let cancelled = false;
		setSource(null);
		decodeToRgba(src)
			.then((rgba) => {
				if (!cancelled) setSource(rgba);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [src]);

	// Re-render whenever the source, corners, or knobs change — coalesced to one
	// animation frame so a fast drag doesn't queue a warp per pointer event.
	useEffect(() => {
		if (!source) return;
		if (rafRef.current) cancelAnimationFrame(rafRef.current);
		rafRef.current = requestAnimationFrame(() => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			const p = { ...DEFAULT_REFRAME_PARAMS, ...params };
			const px = corners.map(([x, y]) => [
				x * (source.width - 1),
				y * (source.height - 1),
			]) as Corners;
			const tone = p.skipTone
				? false
				: { wbStrength: p.wbStrength, lowPct: p.lowPct, highPct: p.highPct };
			let image: RgbaImage;
			if (matte) {
				// The matte wears the same softened grade the server stores (gentler
				// white-balance + polish than the square hero), so the preview matches.
				const matteGrade = matteToneFromParams(params);
				const opts: MatteOptions = {
					canvasSize: PREVIEW_SIZE,
					contentSize: Math.round(PREVIEW_SIZE * (1 - 2 * MATTE_MARGIN)),
					feather: 2,
					tone: matteGrade.tone,
					polish: matteGrade.polish,
					// Tight, dark contact shadow (mirrors the server SHADOW fractions).
					shadow: {
						blur: Math.round(PREVIEW_SIZE * 0.006),
						offsetX: Math.round(PREVIEW_SIZE * 0.002),
						offsetY: Math.round(PREVIEW_SIZE * 0.004),
						opacity: 0.55,
					},
					// Split the difference between fully-square and the natural perspective
					// (mirrors the server MATTE_STRAIGHTEN).
					straighten: 0.5,
					// Bleed the sleeve colour into the margin so the warp edge stays off the
					// wood (scaled down for the small preview).
					bleed: 2,
				};
				image = matteFromCorners(source, px, opts).shadow;
			} else {
				image = reframeFromCorners(source, px, {
					canvasSize: PREVIEW_SIZE,
					contentSize: PREVIEW_SIZE,
					tone,
				}).image;
				applyPolish(image, p.saturation, p.contrast, p.gamma);
			}
			canvas.width = image.width;
			canvas.height = image.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			// Copy into a fresh ImageData (its buffer is a plain ArrayBuffer, which the
			// warp result's Uint8ClampedArray may not be) before blitting.
			const out = ctx.createImageData(image.width, image.height);
			out.data.set(image.data);
			ctx.putImageData(out, 0, 0);
		});
		return () => {
			if (rafRef.current) cancelAnimationFrame(rafRef.current);
		};
	}, [source, corners, params, matte]);

	return (
		<div
			className={cn(
				"relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border",
				matte ? "bg-background" : "bg-muted",
				className,
			)}
			// A checkerboard behind the matte, so its transparent margin + soft edges
			// read as transparency (not a solid fill) while dragging.
			style={
				matte
					? {
							backgroundImage:
								"repeating-conic-gradient(hsl(var(--muted)) 0% 25%, transparent 0% 50%)",
							backgroundSize: "24px 24px",
						}
					: undefined
			}
		>
			<canvas ref={canvasRef} className="size-full" />
			{!source && (
				<span className="absolute inset-0 flex items-center justify-center bg-background/60">
					<Loader2 className="size-5 animate-spin" />
				</span>
			)}
		</div>
	);
}
