import { cn } from "#/lib/utils";

/**
 * The physical disc(s) sitting behind a cover tile, fully hidden at rest — see
 * `.vinyl-peek` in `styles.css` for the hover slide-out (sideways, in the
 * collection grid) and `.vinyl-peek--static` (a small permanent peek, for the
 * record detail panel, which has no hover). Deliberately never reveals the
 * center label/spindle hole even at full reveal, so unlike `SleevePlaceholder`
 * this only draws the outer disc body + groove rings — no label, no spindle.
 *
 * The color/material comes from an AI-generated reference texture (one swatch per
 * `colors` row, cached in R2 — see `color-texture.ts`), tiled in as an SVG pattern
 * fill; the disc shape, sizing and stacking are all procedural so they stay cheap
 * and crisp regardless of what the swatch looks like. `VINYL_OVERLAY_SRC` is a
 * per-size PNG of a "clear" vinyl record (grooves + a glassy sheen highlight, no
 * color of its own), composited on top with `mix-blend-mode: overlay` so the same
 * groove geometry reads consistently across every color, rather than baking
 * grooves into each generated texture (which would drift — a fresh generation per
 * color name, no shared geometry).
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
	/**
	 * Translucent vinyl (`colors.translucent`): render the disc's colour fill
	 * semi-transparent so the page background shows through when it peeks out,
	 * matching how a "Transparent Red"/"Clear" pressing actually looks.
	 */
	translucent?: boolean | null;
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
	translucent,
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
			className={cn(
				"vinyl-peek pointer-events-none absolute inset-0",
				className,
			)}
			style={
				{
					"--vinyl-scale": scale,
					"--vinyl-layers": layers,
				} as React.CSSProperties
			}
			aria-hidden="true"
		>
			{/* Back-most layer first so later (front) layers paint over it. */}
			{Array.from({ length: layers }, (_, i) => layers - 1 - i).map((i) => (
				<svg
					key={i}
					viewBox="0 0 100 100"
					// A stacked disc's rest-state rotation (`.vinyl-disc` in styles.css,
					// `-3deg` per layer behind the front one) rotates a *square* box,
					// which grows its bounding box beyond the tile — a fixed px inset
					// couldn't out-grow that on a big tile even though it was plenty on
					// a small one. `inset-[5%]` scales with the tile instead, and 5% is
					// enough margin to keep even a 3-disc stack's rotated corners from
					// poking past the tile's own edge at any size. `size-[90%]` pairs
					// with it explicitly rather than leaving width/height to be implied
					// by the four insets — Safari doesn't derive a replaced element's
					// (this `<svg>`, sized from its own `viewBox`) box size from `inset`
					// the way it should per spec, and instead renders it at full
					// intrinsic/container size regardless of the inset percentages,
					// which read as the disc being oversized and poking out well past
					// where the 5% margin should have kept it. An explicit `size-[90%]`
					// (== 100% - 2×5%) gives Safari a width/height it can't ignore.
					className="vinyl-disc absolute inset-[5%] size-[90%]"
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
					{/* Fill: the color/pattern, per `colors.textureImageKey`. Translucent
					    pressings drop the fill's opacity so the page shows through. */}
					<circle
						cx="50"
						cy="50"
						r="49"
						fill={hasTexture ? `url(#${patternId})` : "currentColor"}
						fillOpacity={translucent ? 0.45 : undefined}
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
						opacity="0.6"
					/>
				</svg>
			))}
		</div>
	);
}
