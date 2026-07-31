import { cn } from "#/lib/utils";

/**
 * The physical disc(s) peeking out from behind a cover tile — see `.vinyl-peek` in
 * `styles.css` for the hover rotate/slide-out. Deliberately never reveals the
 * center label/spindle hole (it sits behind the sleeve at rest and the hover slide
 * isn't far enough to expose it either), so unlike `SleevePlaceholder` this only
 * draws the outer disc body + groove rings — no label, no spindle.
 *
 * The color/material comes from an AI-generated reference texture (one swatch per
 * `colors` row, cached in R2 — see `color-texture.ts`), tiled in as an SVG pattern
 * fill; the disc shape, sizing and stacking are all procedural so they stay cheap
 * and crisp regardless of what the swatch looks like. `VINYL_OVERLAY_SRC` is a
 * per-size PNG of a "clear" vinyl record (grooves + a glassy sheen highlight, no
 * color of its own), composited on top with `mix-blend-mode: overlay` so the same
 * groove geometry reads consistently across every color, rather than baking
 * grooves into each generated texture (which would drift — a fresh generation per
 * color name, no shared geometry). Currently placeholder art generated from
 * `clear-vinyl-overlay.svg`; swap the files at these paths for the real renders.
 */

/** Relative disc diameter by physical size — a 7" record reads smaller than a 12". */
const SIZE_SCALE: Record<string, number> = {
	'12"': 1,
	'10"': 0.86,
	'7"': 0.72,
};

/** Per-size "clear vinyl" overlay art (grooves + sheen) — see the module doc above. */
const VINYL_OVERLAY_SRC: Record<string, string> = {
	'12"': "/vinyl/clear-12.png",
	'10"': "/vinyl/clear-10.png",
	'7"': "/vinyl/clear-7.png",
};

function scaleForSize(size: string | null | undefined): number {
	if (!size) return 1;
	return SIZE_SCALE[size] ?? 1;
}

function overlaySrcForSize(size: string | null | undefined): string {
	if (!size) return VINYL_OVERLAY_SRC['12"'];
	return VINYL_OVERLAY_SRC[size] ?? VINYL_OVERLAY_SRC['12"'];
}

interface VinylDiscProps {
	/** R2 key for the color's reference texture (`colors.textureImageKey`). */
	textureImageKey?: string | null;
	textureStatus?: string | null;
	colorName?: string | null;
	/** Physical size, e.g. '12"' / '10"' / '7"' — scales the disc diameter. */
	size?: string | null;
	/** Discs to stack (capped at 3 — a box set reads the same as a triple LP). */
	discCount?: number | null;
	className?: string;
}

const MAX_STACK = 3;

export function VinylDisc({
	textureImageKey,
	textureStatus,
	colorName,
	size,
	discCount,
	className,
}: VinylDiscProps) {
	const scale = scaleForSize(size);
	const overlaySrc = overlaySrcForSize(size);
	const layers = Math.min(Math.max(discCount ?? 1, 1), MAX_STACK);
	const patternId = `vinyl-texture-${textureImageKey ?? "none"}`;
	const hasTexture = textureStatus === "ready" && !!textureImageKey;

	return (
		<div
			// A deliberate square (not `inset-0` of the wrapper) — the wrapper is
			// wider than tall (it reserves peek room as right padding, see
			// collection-view.tsx), so stretching to fill it would squash the
			// circle. `aspect-square` + `inset-y-0` instead matches the cover's own
			// (shrunk) box exactly; the hover/rest translate slides it right into
			// the reserved padding.
			className={cn(
				"vinyl-peek pointer-events-none absolute inset-y-0 left-0 aspect-square",
				className,
			)}
			style={{ "--vinyl-scale": scale } as React.CSSProperties}
			aria-hidden="true"
		>
			{/* Back-most layer first so later (front) layers paint over it. */}
			{Array.from({ length: layers }, (_, i) => layers - 1 - i).map((i) => (
				<svg
					key={i}
					viewBox="0 0 100 100"
					className="vinyl-disc absolute inset-0 size-full"
					style={{ "--vinyl-stack-index": i } as React.CSSProperties}
				>
					<title>{colorName ? `${colorName} vinyl` : "Vinyl record"}</title>
					{hasTexture && (
						<defs>
							<pattern
								id={patternId}
								patternUnits="objectBoundingBox"
								width="1"
								height="1"
							>
								<image
									href={`/api/photos/${textureImageKey}`}
									x="0"
									y="0"
									width="100"
									height="100"
									preserveAspectRatio="xMidYMid slice"
								/>
							</pattern>
						</defs>
					)}
					{/* Fill: the color/pattern, per `colors.textureImageKey`. */}
					<circle
						cx="50"
						cy="50"
						r="48"
						fill={hasTexture ? `url(#${patternId})` : "currentColor"}
						className={hasTexture ? undefined : "text-foreground/70"}
					/>
					{/* Overlay: shared "clear vinyl" grooves + sheen art, blended on
					    top of the fill (see `VINYL_OVERLAY_SRC` above). */}
					<image
						href={overlaySrc}
						x="1"
						y="1"
						width="98"
						height="98"
						style={{ mixBlendMode: "overlay" }}
					/>
				</svg>
			))}
		</div>
	);
}
