import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

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
 *
 * `scrollActive` (mobile only) is the touch equivalent of hover — set by
 * `CollectionGrid`'s scroll-driven `IntersectionObserver` for whichever tile
 * is currently centred, since touch devices have no hover to key off. It
 * feeds into the same `data-active` attribute the tooltip's own open state
 * already drives, so the grayscale→colour/disc-peek treatment is shared
 * rather than duplicated. `hideTooltip` (also mobile) skips mounting the
 * per-tile Radix tooltip there — `CollectionGrid` renders one shared,
 * fixed-position tooltip instead (see `MobileNowShowing`).
 */
function RecordTile({
	record,
	onOpen,
	spanning = false,
	scrollActive = false,
	hideTooltip = false,
}: {
	record: PublicRecord;
	onOpen: (record: PublicRecord) => void;
	spanning?: boolean;
	scrollActive?: boolean;
	hideTooltip?: boolean;
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
			data-record-id={record.id}
			data-active={tooltipOpen || scrollActive ? "true" : undefined}
			// Separate from `data-active` above (which also covers desktop's
			// tooltip-open state) so the scale-up below only kicks in for
			// mobile's scroll-driven "hover", not a mouse hover/tooltip on
			// desktop — that already gets its own pop via `.vinyl-disc`'s hover
			// transform without the cover itself scaling too.
			data-scroll-active={scrollActive ? "true" : undefined}
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
									"m-1/16 transition-opacity duration-700 ease-out motion-reduce:transition-none delay-700",
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
											// hidden frame, skipping the fade entirely. Scale is
											// mobile-only (`data-scroll-active`, not the shared
											// `data-active`) — a gentle zoom standing in for the
											// pointer-driven spotlight desktop gets instead. The
											// parent's `overflow-hidden` clips it, so it zooms in
											// place rather than growing the tile's footprint.
											// Tailwind v4's `scale-*` compiles to the native CSS
											// `scale` property, not `transform` — transitioning
											// `transform` here would silently do nothing to it.
											"size-full grayscale transition-[opacity,filter,scale] duration-500 ease-out group-hover:grayscale-0 group-data-[active=true]:grayscale-0 group-data-[scroll-active=true]:scale-105",
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
								<div className="dot-pulse pointer-events-none absolute top-1/12 left-1/12 size-2 rounded-full bg-brand border-1 border-black/20 opacity-100 transition-opacity duration-300 ease-out group-hover:opacity-0 group-data-[active=true]:opacity-0" />
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
				    rather than a generic popover fade.

				    Skipped on mobile (`hideTooltip`) — touch has no hover to trigger
				    it off, and the fixed bottom bar (`MobileNowShowing`, driven by
				    scroll instead) replaces it there. */}
				{!hideTooltip && (
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
								"flex items-start justify-center gap-1.5 text-balance font-serif text-base font-medium leading-tight max-w-(--radix-popper-anchor-width)",
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
							{/* Same "has notes" signal as the tile's own corner dot, echoed
							    here since the tooltip can be the first place you actually
							    read the title. */}
							{hasNotes(record) && (
								<span className="inline-block size-1.5 shrink-0 rounded-full bg-brand mt-1.5" />
							)}
							{record.title}
						</p>
						<p className="font-mono text-muted-foreground text-xs">
							{record.artist}
						</p>
					</TooltipContent>
				)}
			</Tooltip>
		</div>
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// How much of the remaining distance to the spotlight's target the eased
// position closes each animation frame — lower reads as laggier/dreamier,
// higher snaps closer to instant (1 would be the old 1:1 tracking).
const SPOTLIGHT_EASE = 0.09;
// Below this many px from the target, the eased position just snaps the
// rest of the way and the animation loop stops — otherwise it'd tick
// forever, asymptotically approaching but never quite reaching it.
const SPOTLIGHT_SETTLE_PX = 0.5;
// How far (px) tilt can nudge the spotlight from the active tile's centre.
const TILT_MAX_OFFSET_PX = 50;
// Degrees of tilt (either axis, from the phone's resting orientation) that
// maps to the full TILT_MAX_OFFSET_PX nudge.
const TILT_MAX_DEGREES = 30;

/**
 * Touch/no-hover devices (phones, tablets) get the scroll-driven "active
 * tile" + tilt-driven spotlight + fixed bottom tooltip in `CollectionGrid`
 * below, instead of mouse-hover + a per-tile popover — there's no cursor or
 * hover state to drive either of those with. Re-checked on resize/rotation
 * (a foldable, or a mouse getting plugged in) rather than pinned at mount.
 */
function useIsTouchDevice(): boolean {
	const [isTouch, setIsTouch] = useState(false);
	useEffect(() => {
		const query = window.matchMedia("(hover: none) and (pointer: coarse)");
		setIsTouch(query.matches);
		const onChange = () => setIsTouch(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return isTouch;
}

/**
 * Read in a ref (not state) — it's only consulted from `setSpotlightTarget`,
 * which is called at pointer/tilt/scroll rate, so routing it through a
 * re-render would be wasted work for a value that never needs to trigger one.
 */
function usePrefersReducedMotionRef(): React.RefObject<boolean> {
	const ref = useRef(false);
	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		ref.current = query.matches;
		const onChange = () => {
			ref.current = query.matches;
		};
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return ref;
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
 *
 * On touch devices (`useIsTouchDevice`), hover's whole job — which tile is
 * "active", and where the spotlight backdrop sits — is instead driven by
 * scroll (an `IntersectionObserver` watching a thin band through the
 * viewport's centre) plus device tilt (a small nudge on top of the active
 * tile's own position, since there's no cursor to place the spotlight at).
 * The per-tile Radix tooltip is replaced by one shared, fixed bottom bar
 * (`MobileNowShowing`) that tracks the same active tile.
 */
export function CollectionGrid({
	records,
	onOpen,
	focusedRecordId,
}: {
	records: PublicRecord[];
	onOpen: (record: PublicRecord) => void;
	// The id of whichever record the detail panel currently has open — kept
	// in sync even while the panel covers the grid (e.g. paging prev/next
	// inside it) so the grid is already scrolled to that tile underneath by
	// the time the panel closes, instead of leaving you wherever you were
	// before it opened.
	focusedRecordId?: number | null;
}) {
	const spanningIds = useMemo(() => computeSpanningIds(records), [records]);
	const gridStyle: React.CSSProperties = {
		display: "grid",
		gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_PX}px, 1fr))`,
		gridAutoColumns: `minmax(${TILE_MIN_PX}px, 1fr)`,
		gridAutoFlow: "dense",
		gap: `${GAP_REM}rem`,
	};
	const isTouch = useIsTouchDevice();
	const gridElRef = useRef<HTMLDivElement>(null);
	const prefersReducedMotionRef = usePrefersReducedMotionRef();

	// Keeps the grid scrolled to whichever record the detail panel has open
	// while paging prev/next inside it (smoothly — the panel covers most of
	// the viewport but not all of it, so the motion is visible at the edges
	// and should read as deliberate rather than a snap), so closing the panel
	// never leaves you scrolled back to wherever you were when it first
	// opened. Only fires on a change *between* two already-open records
	// (prevFocusedId starts non-null) — the initial open from a grid click is
	// skipped, since that tile is already on screen (you just clicked it) and
	// re-centring it would nudge the grid visibly mid slide-in, right as the
	// panel that's meant to hide this motion is still becoming opaque.
	const prevFocusedIdRef = useRef<number | null>(null);
	useEffect(() => {
		const prevFocusedId = prevFocusedIdRef.current;
		prevFocusedIdRef.current = focusedRecordId ?? null;
		if (
			focusedRecordId == null ||
			prevFocusedId == null ||
			prevFocusedId === focusedRecordId ||
			!gridElRef.current
		) {
			return;
		}
		const el = gridElRef.current.querySelector<HTMLElement>(
			`[data-record-id="${focusedRecordId}"]`,
		);
		el?.scrollIntoView({
			block: "center",
			behavior: prefersReducedMotionRef.current ? "auto" : "smooth",
		});
	}, [focusedRecordId, prefersReducedMotionRef]);

	// Written straight to the DOM (not React state) so the gradient can track
	// every pointer move at native rate — routing this through a re-render
	// would both lag a frame behind the cursor and re-render every tile for a
	// value none of them actually read.
	const overlayRef = useRef<HTMLDivElement>(null);

	// --- Eased spotlight position -------------------------------------------
	// `target` is where the spotlight is headed (the pointer on desktop; the
	// active tile's centre plus a tilt nudge on mobile — both set below);
	// `current` is what's actually painted, chasing `target` by a fraction of
	// the remaining distance every animation frame instead of snapping
	// straight to it (see SPOTLIGHT_EASE). Both live in refs, not state, so
	// tracking never itself triggers a React re-render.
	const targetRef = useRef({ x: 0, y: 0 });
	const currentRef = useRef({ x: 0, y: 0 });
	const rafRef = useRef<number | null>(null);

	const tick = useCallback(() => {
		const target = targetRef.current;
		const current = currentRef.current;
		const dx = target.x - current.x;
		const dy = target.y - current.y;
		if (
			Math.abs(dx) < SPOTLIGHT_SETTLE_PX &&
			Math.abs(dy) < SPOTLIGHT_SETTLE_PX
		) {
			current.x = target.x;
			current.y = target.y;
			rafRef.current = null;
		} else {
			current.x += dx * SPOTLIGHT_EASE;
			current.y += dy * SPOTLIGHT_EASE;
			rafRef.current = requestAnimationFrame(tick);
		}
		overlayRef.current?.style.setProperty("--overlay-x", `${current.x}px`);
		overlayRef.current?.style.setProperty("--overlay-y", `${current.y}px`);
	}, []);

	const setSpotlightTarget = useCallback(
		(x: number, y: number) => {
			targetRef.current = { x, y };
			// Reduced motion: jump straight to the target instead of chasing it
			// frame by frame — the whole point of the eased rAF loop is the chase.
			if (prefersReducedMotionRef.current) {
				if (rafRef.current != null) {
					cancelAnimationFrame(rafRef.current);
					rafRef.current = null;
				}
				currentRef.current = { x, y };
				overlayRef.current?.style.setProperty("--overlay-x", `${x}px`);
				overlayRef.current?.style.setProperty("--overlay-y", `${y}px`);
				return;
			}
			if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
		},
		[tick, prefersReducedMotionRef],
	);

	useEffect(
		() => () => {
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
		},
		[],
	);

	// --- Mobile: scroll-driven "active" tile (hover's touch equivalent) ----
	const [activeId, setActiveId] = useState<number | null>(null);
	// `records` isn't read in the effect body below, but the observer is
	// wired up to whatever `[data-record-id]` tiles exist in the DOM right
	// now — if `records` changes (e.g. more load in), those are new elements
	// that need observing too, so the effect has to rerun.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (!isTouch || !gridElRef.current) return;
		const container = gridElRef.current;
		// Which tiles are currently in the band, and their elements (so we can
		// re-measure live on scroll — see `onScroll` below). `threshold: 0` only
		// fires this observer when a tile crosses in/out of the band, not on
		// every scroll tick in between, so it's just membership tracking.
		const elements = new Map<number, HTMLElement>();
		const intersecting = new Set<number>();

		// Several tiles can share the band at once (a wide row). Whichever one
		// gets picked is decided by where the viewport's vertical centre — a
		// fixed line on the page — currently falls within *that row's* own
		// height: at the row's top edge it's the leftmost tile, at the row's
		// bottom edge the rightmost, and everywhere between sweeps left-to-right
		// with it. Re-run on every scroll tick (not just on the observer's
		// enter/exit events) since a tall row can dwell in the band for a while,
		// and the selection needs to keep tracking the centre line the whole
		// time it's there, not just jump once when the row enters/leaves.
		function updateActive() {
			const inBand = [...intersecting]
				.map((id) => [id, elements.get(id)?.getBoundingClientRect()] as const)
				.filter((entry): entry is [number, DOMRect] => entry[1] !== undefined);
			let next: number | null = null;
			if (inBand.length > 0) {
				const centerY = window.innerHeight / 2;
				// The band can briefly hold tiles from two different rows at once
				// (one row's tiles exiting as the next row's are entering) — mixing
				// their rects together made rowTop/rowBottom span both rows, which
				// threw the fraction (and the picked tile) around wildly. It also
				// held a spanning (2×2) tile alongside a row of regular ones sitting
				// beside it — dense packing means a spanning tile's height matches
				// two ordinary rows combined, so it vertically overlaps *both*, and
				// naively grouping by overlap alone pulled it into whichever row's
				// fraction happened to be closest, making the two small rows blow
				// through their four tiles almost instantly. Anchor on whichever
				// tile's centre is actually closest to the centre line first, then
				// only consider tiles that both overlap it *and* are roughly the
				// same size — same row, same size class — for the left-to-right
				// sweep.
				const anchor = inBand.reduce((closest, entry) => {
					const [, rect] = entry;
					const [, closestRect] = closest;
					const dist = Math.abs(rect.top + rect.height / 2 - centerY);
					const closestDist = Math.abs(
						closestRect.top + closestRect.height / 2 - centerY,
					);
					return dist < closestDist ? entry : closest;
				});
				const [, anchorRect] = anchor;
				const row = inBand
					.filter(([, r]) => {
						const overlaps =
							r.top < anchorRect.bottom && r.bottom > anchorRect.top;
						const sameSize =
							r.height / anchorRect.height > 0.5 &&
							r.height / anchorRect.height < 1.5;
						return overlaps && sameSize;
					})
					.sort((a, b) => a[1].left - b[1].left);
				// The leftmost and rightmost tile's rects nudge the row's own
				// top/bottom by 1px apart (left up, right down) before they feed the
				// fraction split below. Two side-by-side tiles can render with
				// sub-pixel-different bounds (CSS Grid rounds fractional column
				// widths independently per cell), so the "true" 50% boundary
				// between them isn't always exactly at the row's own midpoint —
				// close enough that a scroll position dead-centre on the pair
				// could floor to whichever tile's rect happened to round a hair
				// short, which is the side you'd see highlighted while scrolling
				// but not the one that actually opens once you dismiss. This
				// breaks that tie in the direction it was actually observed to
				// land wrong, rather than leaving it to sub-pixel rounding.
				const rowTop = Math.min(
					...row.map(([, r], i) => r.top + (i === 0 ? -1 : 0)),
				);
				const rowBottom = Math.max(
					...row.map(([, r], i) => r.bottom + (i === row.length - 1 ? 1 : 0)),
				);
				const fraction =
					rowBottom > rowTop ? (centerY - rowTop) / (rowBottom - rowTop) : 0;
				const index = Math.min(
					row.length - 1,
					Math.max(0, Math.floor(fraction * row.length)),
				);
				next = row[index][0];
			}
			// Reuses the same `data-pointer-outside` attribute desktop's
			// `onPointerLeave`/`Enter` set below — no active tile (scrolled above
			// the first record or below the last) is mobile's equivalent of the
			// pointer leaving the grid, and should fade the overlay out at the
			// same quick pace rather than the long inter-tile linger.
			if (next == null) {
				container.setAttribute("data-pointer-outside", "true");
			} else {
				container.removeAttribute("data-pointer-outside");
			}
			setActiveId(next);
		}

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = Number((entry.target as HTMLElement).dataset.recordId);
					if (entry.isIntersecting) intersecting.add(id);
					else intersecting.delete(id);
				}
				updateActive();
			},
			// A thin horizontal band through the viewport's vertical centre —
			// whichever tile is crossing it is "the one you're looking at".
			{ rootMargin: "-45% 0px -45% 0px", threshold: 0 },
		);
		for (const el of container.querySelectorAll<HTMLElement>(
			"[data-record-id]",
		)) {
			const id = Number(el.dataset.recordId);
			elements.set(id, el);
			observer.observe(el);
		}

		let rafId: number | null = null;
		const onScroll = () => {
			if (rafId !== null || intersecting.size === 0) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				updateActive();
			});
		};
		window.addEventListener("scroll", onScroll, { passive: true });

		return () => {
			observer.disconnect();
			window.removeEventListener("scroll", onScroll);
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [isTouch, records]);

	const activeRecord = useMemo(
		() => records.find((r) => r.id === activeId) ?? null,
		[records, activeId],
	);

	// The active tile's on-screen centre is the spotlight's base position on
	// mobile — there's no cursor, so tilt (below) nudges around this instead
	// of driving the position outright. Recomputed whenever the active tile
	// changes, and again on scroll since the *tile* stays active across a
	// scroll but its on-screen position doesn't.
	const activeCenterRef = useRef({ x: 0, y: 0 });
	const tiltOffsetRef = useRef({ x: 0, y: 0 });

	const recomputeActiveCenter = useCallback(() => {
		if (!isTouch || activeId == null || !gridElRef.current) return;
		const el = gridElRef.current.querySelector<HTMLElement>(
			`[data-record-id="${activeId}"]`,
		);
		if (!el) return;
		const rect = el.getBoundingClientRect();
		activeCenterRef.current = {
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		};
		setSpotlightTarget(
			activeCenterRef.current.x + tiltOffsetRef.current.x,
			activeCenterRef.current.y + tiltOffsetRef.current.y,
		);
	}, [isTouch, activeId, setSpotlightTarget]);

	useEffect(() => {
		recomputeActiveCenter();
	}, [recomputeActiveCenter]);

	useEffect(() => {
		if (!isTouch) return;
		// rAF-throttled — scroll fires far faster than a `getBoundingClientRect`
		// read needs to keep up with, and reading layout on every event risks
		// forcing a synchronous layout mid-scroll.
		let ticking = false;
		const onScroll = () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				recomputeActiveCenter();
				ticking = false;
			});
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, [isTouch, recomputeActiveCenter]);

	// --- Mobile: tilt nudges the spotlight around the active tile ----------
	useEffect(() => {
		if (!isTouch) return;
		let calibrated: { beta: number; gamma: number } | null = null;
		const onOrientation = (e: DeviceOrientationEvent) => {
			if (e.beta == null || e.gamma == null) return;
			// Calibrate off however the phone happens to be held when tilt
			// tracking starts, rather than its absolute angle — a phone resting
			// in a hand is rarely flat, and an absolute reading would leave the
			// spotlight permanently off-centre until the phone was levelled.
			if (!calibrated) calibrated = { beta: e.beta, gamma: e.gamma };
			const dBeta = clamp(
				e.beta - calibrated.beta,
				-TILT_MAX_DEGREES,
				TILT_MAX_DEGREES,
			);
			const dGamma = clamp(
				e.gamma - calibrated.gamma,
				-TILT_MAX_DEGREES,
				TILT_MAX_DEGREES,
			);
			tiltOffsetRef.current = {
				x: (dGamma / TILT_MAX_DEGREES) * TILT_MAX_OFFSET_PX,
				y: (dBeta / TILT_MAX_DEGREES) * TILT_MAX_OFFSET_PX,
			};
			setSpotlightTarget(
				activeCenterRef.current.x + tiltOffsetRef.current.x,
				activeCenterRef.current.y + tiltOffsetRef.current.y,
			);
		};

		let detach: (() => void) | undefined;
		const attach = () => {
			window.addEventListener("deviceorientation", onOrientation);
			detach = () =>
				window.removeEventListener("deviceorientation", onOrientation);
		};

		const requestPermission = (
			DeviceOrientationEvent as unknown as {
				requestPermission?: () => Promise<"granted" | "denied">;
			}
		).requestPermission;
		if (typeof requestPermission === "function") {
			// iOS only grants motion-sensor access from inside a user gesture —
			// the grid's own first touch doubles as that gesture, so there's no
			// separate "enable tilt" button to tap through first.
			const onFirstTouch = () => {
				requestPermission().then((state) => {
					if (state === "granted") attach();
				});
			};
			const el = gridElRef.current;
			el?.addEventListener("touchstart", onFirstTouch, { once: true });
			return () => {
				el?.removeEventListener("touchstart", onFirstTouch);
				detach?.();
			};
		}

		attach();
		return () => detach?.();
	}, [isTouch, setSpotlightTarget]);

	return (
		<div
			ref={gridElRef}
			className="collection-grid"
			style={gridStyle}
			onPointerMove={
				isTouch ? undefined : (e) => setSpotlightTarget(e.clientX, e.clientY)
			}
			// `data-pointer-outside` (see `.grid-focus-overlay` in styles.css) tells
			// the overlay's fade-out whether the pointer left the whole grid or just
			// hopped the gap between two tiles — `onPointerLeave`/`Enter` (unlike
			// `onPointerMove`) don't fire for that inner hop since they're the
			// non-bubbling enter/leave pair, only the outer boundary crossing. Written
			// straight to the DOM rather than React state — same reasoning as the
			// spotlight position above, this never needs to trigger a re-render.
			onPointerLeave={
				isTouch
					? undefined
					: (e) => e.currentTarget.setAttribute("data-pointer-outside", "true")
			}
			onPointerEnter={
				isTouch
					? undefined
					: (e) => e.currentTarget.removeAttribute("data-pointer-outside")
			}
		>
			{records.map((record) => (
				<RecordTile
					key={record.id}
					record={record}
					onOpen={onOpen}
					spanning={spanningIds.has(record.id)}
					scrollActive={isTouch && record.id === activeId}
					hideTooltip={isTouch}
				/>
			))}
			{/* Shared hover backdrop for every tile — see `.grid-focus-overlay` in
			    styles.css. `position: fixed` excludes it from the grid's own auto-
			    placement (an in-flow child here would otherwise consume a cell).
			    Masked to a radial gradient centred on the eased spotlight position
			    above (`--overlay-x/y`) so the blur opens up right where the
			    cursor/active tile is instead of snapping between "sharp tile" and
			    "blurred everything else" with nothing in between. */}
			<div
				ref={overlayRef}
				aria-hidden="true"
				className="grid-focus-overlay pointer-events-none fixed inset-0 bg-white/50 opacity-0 backdrop-blur-sm dark:bg-black/50"
			/>
			{isTouch && activeRecord && <MobileNowShowing record={activeRecord} />}
		</div>
	);
}

/**
 * Touch's replacement for the per-tile Radix tooltip: one shared bar fixed to
 * the bottom of the viewport, showing whichever record `CollectionGrid`'s
 * scroll-driven `IntersectionObserver` currently considers "active" — see the
 * comment on `CollectionGrid`. Deliberately plain text (no `.title-palette`
 * gradient like the desktop tooltip) — it swaps records as fast as the user
 * scrolls, and re-parsing a palette gradient into a fixed bar on every scroll
 * tick isn't worth it for a label that's only ever on screen a moment.
 */
function MobileNowShowing({ record }: { record: PublicRecord }) {
	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
			<div className="flex max-w-[calc(100%-2rem)] flex-col items-center gap-0.5 rounded-md border bg-popover/95 px-4 py-2 text-center text-popover-foreground shadow-lg backdrop-blur-sm">
				<p className="text-balance font-serif text-base font-medium leading-tight">
					{record.title}
				</p>
				<p className="font-mono text-muted-foreground text-xs">
					{record.artist}
				</p>
			</div>
		</div>
	);
}
