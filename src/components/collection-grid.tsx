import { type CSSProperties, useMemo, useState } from "react";

import { FadeImage, isImageDecoded } from "#/components/fade-image";
import { SleevePlaceholder } from "#/components/sleeve-placeholder";
import { Skeleton } from "#/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "#/components/ui/tooltip";
import { VinylDisc } from "#/components/vinyl-disc";
import { parseColorPalette } from "#/lib/color-palette";
import { DEFAULT_COLOR_NAME } from "#/lib/colors";
import { displayCoverKey, displayMatteKey, photoUrl } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";
import { cn } from "#/lib/utils";

// Tailwind `gap-5` (1.25rem / 20px) — the grid's column *and* row gap.
const GAP_REM = 1.25;

// Tiles never render narrower than this. Exported so CollectionSkeleton's
// placeholder grid can use the same tracks and avoid a column jump on load.
export const TILE_MIN_PX = 180;

function hasNotes(record: PublicRecord): boolean {
	return Boolean(record.notes?.trim());
}

// Minimum number of plain 1×1 tiles between two 2×2 "notes" tiles — see
// `computeSpanningIds`.
const MIN_SPAN_GAP = 3;

/**
 * Which records render as a 2×2 "spanning" tile instead of the default 1×1.
 * Every record with notes is *eligible*, but consecutive eligible records are
 * throttled to at least `MIN_SPAN_GAP` tiles apart, so a run of back-to-back
 * notes-bearing records in the collection (common here) reads as occasional
 * feature moments rather than a wall of oversized tiles. Records skipped this
 * way still show their notes — normally, in the detail panel — this only
 * affects the grid tile's size.
 */
function computeSpanningIds(records: PublicRecord[]): Set<number> {
	const spanning = new Set<number>();
	let sinceLastSpan = MIN_SPAN_GAP;
	for (const record of records) {
		if (hasNotes(record) && sinceLastSpan >= MIN_SPAN_GAP) {
			spanning.add(record.id);
			sinceLastSpan = 0;
		} else {
			sinceLastSpan++;
		}
	}
	return spanning;
}

/**
 * One cover tile: the peeking vinyl disc behind the cover, plus a real
 * (Radix, portal-rendered) tooltip carrying the title/artist. `.group` drives
 * the hover states (grayscale→colour, the disc slide-out+scale-up, the
 * pencil-badge fade) — both via plain CSS `:hover` for an instant response
 * *and* via `data-active` (set from the tooltip's own open state) so they
 * stay live while the pointer moves onto the (portaled, DOM-detached)
 * tooltip content too — see `tooltipOpen` below. The disc deliberately
 * overflows the tile sideways (and rises above sibling tiles on hover/active
 * — see `.vinyl-peek` in styles.css — so it isn't painted over by the next
 * cell in DOM order), so the cover's own wrapper carries the aspect ratio
 * but not `overflow-hidden` — only the innermost box (just the image) clips.
 *
 * Every tile is a perfect square — no text block underneath pushing the tile
 * taller than wide, which is what a 2×2 `spanning` tile needs to actually
 * come out square. `spanning` claims a 2×2 slot in the parent grid (see
 * `computeSpanningIds`). `alignSelf: "start"` (spanning only) opts out of the
 * grid's default stretch, so a 2×2 tile doesn't get stretched to match a
 * taller row if this one happens to be the shortest tile in it.
 *
 * The tooltip's title uses the same serif treatment (and, where the chip has
 * an extracted palette, the same `.title-palette` gradient — see styles.css)
 * as the record panel's own title (`record-panel.tsx`).
 */
function RecordTile({
	record,
	onOpen,
	spanning = false,
}: {
	record: PublicRecord;
	onOpen: (record: PublicRecord) => void;
	spanning?: boolean;
}) {
	const matte = displayMatteKey(record);
	const cover = matte ?? displayCoverKey(record);
	// Tiles stay near TILE_MIN_PX wide regardless of viewport (more columns get
	// added instead of individual tiles growing) — 500 covers a ~250px tile at
	// 2x without shipping the ~1MB master. A spanning (2×2) tile is roughly
	// double that, so it gets a correspondingly larger request.
	const coverSrc = cover ? photoUrl(cover, spanning ? 900 : 500) : undefined;
	// Keep the peeking vinyl disc faint (10%) until the cover is up, then fade it to
	// full in step with the cover — so a slow/lazy tile never flashes a bold disc
	// behind a not-yet-loaded (now background-less) cover. No cover at all → the
	// placeholder is there immediately, so the disc shows straight away. Seeded from
	// `FadeImage`'s own decoded-src cache too, so a cover the grid has already shown
	// this session (e.g. scrolling back to a tile the browser had unloaded) mounts
	// the disc at full opacity instead of replaying the fade the cover itself skips.
	const [coverReady, setCoverReady] = useState(
		() => !cover || isImageDecoded(coverSrc),
	);
	// See `.title-palette` in styles.css — a two-stop gradient built from the
	// chip's extracted palette, clipped through the title glyphs. The default
	// (Black) chip has no meaningful palette of its own, so it brands the title
	// in the site accent instead; a chip with a color but no extracted palette
	// yet (not backfilled) just keeps the plain foreground color.
	const isDefaultColor = record.colorName === DEFAULT_COLOR_NAME;
	const palette = isDefaultColor
		? null
		: parseColorPalette(record.colorPalette);
	const paletteFrom = palette?.colors[0];
	const paletteTo = palette?.colors[1] ?? palette?.colors[0];
	// Radix keeps the tooltip open while the pointer is over its (portaled,
	// document-body-level) content too, not just the trigger — but that content
	// lives outside this tile's DOM subtree, so plain CSS `:hover` on `.group`
	// can't see it. Mirroring Radix's own open state onto `data-active` lets
	// `group-data-[active=true]:*` (Tailwind) and `.group[data-active="true"]`
	// (styles.css) keep the hover look — grayscale→colour, the disc peek — alive
	// for exactly as long as Radix says the tooltip is open, hovering the
	// content included.
	const [tooltipOpen, setTooltipOpen] = useState(false);
	return (
		<div
			className="group"
			data-active={tooltipOpen ? "true" : undefined}
			style={
				spanning
					? { gridColumn: "span 2", gridRow: "span 2", alignSelf: "start" }
					: undefined
			}
		>
			<Tooltip onOpenChange={setTooltipOpen}>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={() => onOpen(record)}
						className="block w-full cursor-pointer text-left"
					>
						<div className="relative aspect-square">
							<VinylDisc
								colorName={record.colorName}
								textureImageKey={record.colorTextureImageKey}
								textureStatus={record.colorTextureStatus}
								translucent={record.colorTranslucent}
								size={record.size}
								discCount={record.discCount}
								className={cn(
									"transition-opacity duration-700 ease-out motion-reduce:transition-none delay-700",
									coverReady ? "opacity-100" : "opacity-0",
								)}
							/>
							<div className="absolute inset-0 overflow-hidden">
								{/* Shown behind the cover while it loads — `-z-10` (rather
								    than unmounting once ready) so it never has to fight
								    FadeImage's own opacity for stacking order; the opaque
								    cover simply paints over it once revealed. Cover-less
								    tiles skip straight to the placeholder, so no skeleton
								    for those. */}
								{cover && !coverReady && (
									<Skeleton className="absolute inset-0 -z-10 rounded-none" />
								)}
								{cover ? (
									<FadeImage
										src={coverSrc}
										alt={`${record.artist} — ${record.title}`}
										onReady={() => setCoverReady(true)}
										className={cn(
											// Fade in on load *and* keep the grayscale→colour
											// hover — one combined transition property so both
											// animate. Opacity itself stays driven by FadeImage's
											// own `loaded` state (via onReady below just for the
											// disc) — mirroring it here too would round-trip
											// through a second component's state update, which
											// can resolve before the browser ever paints the
											// hidden frame, skipping the fade entirely.
											"size-full grayscale transition-[opacity,filter] duration-500 ease-out group-hover:grayscale-0 group-data-[active=true]:grayscale-0",
											matte ? "object-contain" : "object-cover",
										)}
										loading="lazy"
									/>
								) : (
									<SleevePlaceholder />
								)}
							</div>
							{/* Signals "this one has notes" at rest — the 2×2 span (when
							    throttled-eligible, see `computeSpanningIds`) is a size
							    hint, not everything with notes gets one, so records that
							    stayed 1×1 still need their own affordance. Fades out on
							    hover so it doesn't fight the tooltip/disc for attention
							    once you're already looking at this tile. */}
							{hasNotes(record) && (
								<div className="pointer-events-none absolute top-1/12 left-1/12 size-3 rounded-full bg-brand border-1 border-black/50 opacity-100 shadow-sm transition-opacity duration-300 ease-out group-hover:opacity-0 group-data-[active=true]:opacity-0" />
							)}
						</div>
					</button>
				</TooltipTrigger>
				{/* A real tooltip (Radix, portal-rendered) rather than an overlay
				    positioned within the tile — sized to its content and collision-
				    aware, so a long title wraps instead of truncating and is never
				    clipped by a neighbouring tile or the viewport edge. Pinned to the
				    trigger's own width (`--radix-popper-anchor-width`, exposed by
				    Radix's Popper primitive) rather than sizing to content, so it
				    always reads as "attached to this cover" instead of a stray,
				    differently-sized box.

				    The entrance overrides tw-animate-css's `--tw-enter-translate-y`/
				    `--tw-enter-scale` custom properties directly via inline style
				    (rather than fighting `TooltipContent`'s default `slide-in-from-
				    top-2 zoom-in-95` classes through `cn`/`twMerge`, which doesn't
				    reliably win a specificity tie between two same-weight utility
				    classes) — inline style always wins for a custom property, no
				    matter what class-based value also tries to set it. A bigger slide,
				    no zoom, reads as the tooltip pulling out from *behind* the cover
				    rather than a generic popover fade. */}
				<TooltipContent
					side="bottom"
					sideOffset={1}
					className="flex flex-col gap-1 text-center"
					style={
						{
							"--tw-enter-translate-y": "-14px",
							"--tw-enter-scale": "1",
							"--tw-exit-translate-y": "-10px",
							"--tw-exit-scale": "1",
						} as CSSProperties
					}
				>
					<p
						className={cn(
							"text-balance font-serif text-base font-medium leading-tight max-w-(--radix-popper-anchor-width)",
							paletteFrom
								? "title-palette bg-clip-text text-transparent"
								: isDefaultColor && "text-brand-strong",
						)}
						style={
							paletteFrom
								? ({
										"--pal-a": paletteFrom,
										"--pal-b": paletteTo,
									} as CSSProperties)
								: undefined
						}
					>
						{record.title}
					</p>
					<p className="font-mono text-muted-foreground text-xs">
						{record.artist}
					</p>
				</TooltipContent>
			</Tooltip>
		</div>
	);
}

/**
 * The record grid: one continuous CSS grid with `grid-auto-flow: dense`, so
 * the browser's own placement algorithm packs every tile — no gaps, because
 * there's no artificial boundary for it to run into.
 *
 * An earlier version window-virtualized this by chunking records into fixed
 * batches, each its own separate CSS grid. That fundamentally can't guarantee
 * zero gaps: a batch boundary falling mid-row leaves that row's remaining
 * cells empty in the first grid, with the next batch starting a fresh row
 * below rather than continuing to fill them — visually a dead rectangle, no
 * matter how large the batch. A single grid has no such boundary. Perf for
 * the (currently few-hundred-record) collection comes from `loading="lazy"`
 * on covers alone — a per-tile `content-visibility: auto` was tried too, but
 * it implies `contain: paint`, which clips a tile's descendants to its own
 * box and defeats the vinyl disc's deliberate peek past the tile's edge (see
 * `.vinyl-peek` in styles.css, which already made — and documented — this
 * same call once before).
 */
export function CollectionGrid({
	records,
	onOpen,
}: {
	records: PublicRecord[];
	onOpen: (record: PublicRecord) => void;
}) {
	const spanningIds = useMemo(() => computeSpanningIds(records), [records]);
	const gridStyle: React.CSSProperties = {
		display: "grid",
		gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_PX}px, 1fr))`,
		gridAutoColumns: `minmax(${TILE_MIN_PX}px, 1fr)`,
		gridAutoFlow: "dense",
		gap: `${GAP_REM}rem`,
	};
	return (
		<div style={gridStyle}>
			{records.map((record) => (
				<RecordTile
					key={record.id}
					record={record}
					onOpen={onOpen}
					spanning={spanningIds.has(record.id)}
				/>
			))}
		</div>
	);
}
