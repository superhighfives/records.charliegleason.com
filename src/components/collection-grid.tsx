import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FadeImage, isImageDecoded } from "#/components/fade-image";
import { SleevePlaceholder } from "#/components/sleeve-placeholder";
import { Skeleton } from "#/components/ui/skeleton";
import { VinylDisc } from "#/components/vinyl-disc";
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
 * One cover tile: the peeking vinyl disc behind the cover. `.group` drives
 * the hover states (grayscale→colour, the disc slide-out+scale-up, the
 * pencil-badge fade) via plain CSS `:hover` for an instant response. The disc
 * deliberately overflows the tile sideways (and rises above sibling tiles on
 * hover/active — see `.vinyl-peek` in styles.css — so it isn't painted over
 * by the next cell in DOM order), so the cover's own wrapper carries the
 * aspect ratio but not `overflow-hidden` — only the innermost box (just the
 * image) clips.
 *
 * Every tile is a perfect square — no text block underneath pushing the tile
 * taller than wide, which is what a 2×2 `spanning` tile needs to actually
 * come out square. `spanning` claims a 2×2 slot in the parent grid (see
 * `computeSpanningIds`). `alignSelf: "start"` (spanning only) opts out of the
 * grid's default stretch, so a 2×2 tile doesn't get stretched to match a
 * taller row if this one happens to be the shortest tile in it.
 *
 * Title/artist aren't shown on the tile itself — `CollectionGrid` renders
 * one shared, fixed-position bar (`NowShowing`) for whichever record is
 * currently "active", so nothing anchored to the tile has to reposition (or
 * get dismissed) as the page scrolls. `active` is set by `CollectionGrid`
 * whenever plain pointer hover can't be relied on to say which tile is
 * "current": mobile's scroll-driven `IntersectionObserver` (touch devices
 * have no hover to key off), and the record currently open in the detail
 * panel (so it stays highlighted underneath while the panel covers the
 * pointer). It drives the shared `data-active` attribute (grayscale→colour,
 * disc peek, the `grid-focus-overlay` blur) and, for the scroll-driven case,
 * the bar's content. `onActivate` (desktop) reports a plain pointer hover
 * into that same shared "active" state so the bar tracks the mouse instead —
 * desktop's own visual feedback stays purely `:hover`-driven, only the bar's
 * *content* comes from this.
 *
 * Wrapped in `memo` — `CollectionGrid` re-renders on every scroll tick on
 * touch (the IntersectionObserver-driven `activeId`, see below), and without
 * this every one of the (currently ~300) tiles would re-render along with
 * it even though at most one or two actually have a changed `active` prop.
 * That was the dominant cost behind the iOS scroll jank this was chasing —
 * a profiled scroll showed React's `performWorkUntilDeadline` alone eating
 * ~4s of main-thread time across a 4s scroll.
 */
const RecordTile = memo(function RecordTile({
	record,
	onOpen,
	spanning = false,
	active = false,
	onActivate,
}: {
	record: PublicRecord;
	onOpen: (record: PublicRecord) => void;
	spanning?: boolean;
	active?: boolean;
	onActivate?: (id: number | null) => void;
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
	return (
		<div
			className="group"
			data-record-id={record.id}
			data-active={active ? "true" : undefined}
			style={
				spanning
					? { gridColumn: "span 2", gridRow: "span 2", alignSelf: "start" }
					: undefined
			}
		>
			<button
				type="button"
				onClick={() => onOpen(record)}
				onPointerEnter={onActivate ? () => onActivate(record.id) : undefined}
				onFocus={onActivate ? () => onActivate(record.id) : undefined}
				onBlur={onActivate ? () => onActivate(null) : undefined}
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
					{/* `content-visibility: auto` — see the module doc above for why this
					    is scoped to the cover's own wrapper rather than the whole tile.
					    Sized purely by `inset-0` against the already-sized `aspect-square`
					    parent, not by its own content, so this doesn't need a
					    `contain-intrinsic-size` fallback the way an intrinsically-sized
					    element would. */}
					<div className="absolute inset-0 overflow-hidden [content-visibility:auto]">
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
									// active-only (mobile's scroll-driven state) — a gentle
									// zoom standing in for the pointer-driven spotlight
									// desktop gets instead. The parent's `overflow-hidden`
									// clips it, so it zooms in place rather than growing
									// the tile's footprint. Tailwind v4's `scale-*`
									// compiles to the native CSS `scale` property, not
									// `transform` — transitioning `transform` here would
									// silently do nothing to it.
									"size-full grayscale transition-[opacity,filter,scale] duration-500 ease-out pointer-fine:group-hover:grayscale-0 group-data-[active=true]:grayscale-0 group-data-[active=true]:scale-105",
									matte ? "object-contain" : "object-cover",
								)}
								loading="lazy"
								decoding="async"
							/>
						) : (
							<SleevePlaceholder />
						)}
					</div>
					{/* Signals "this one has notes" at rest — the 2×2 span (when
					    throttled-eligible, see `computeSpanningIds`) is a size
					    hint, not everything with notes gets one, so records that
					    stayed 1×1 still need their own affordance. Fades out on
					    hover so it doesn't fight the disc for attention once
					    you're already looking at this tile. */}
					{hasNotes(record) && (
						<div className="dot-pulse pointer-events-none absolute top-1/12 left-1/12 size-2 rounded-full bg-brand border-1 border-black/20 opacity-100 transition-opacity duration-300 ease-out pointer-fine:group-hover:opacity-0 group-data-[active=true]:opacity-0" />
					)}
				</div>
			</button>
		</div>
	);
});

// How long the grid takes to glide a paged-to record into view — see
// `smoothScrollCenterTo`. Slower than the browser's own native smooth
// scroll (which has no duration knob to tune in the first place) so paging
// through the record panel reads as a deliberate glide, not a blink.
const GRID_SCROLL_DURATION_MS = 900;

// Ease-in-out-expo, the same overall shape as the grid-focus-overlay's
// fade-in ease-out-expo (see styles.css) but ramping up gently too rather
// than starting at full speed — the grid-centring scroll should read as a
// deliberate glide from a dead stop, not just settle gently at the end.
function easeInOutExpo(t: number): number {
	if (t <= 0) return 0;
	if (t >= 1) return 1;
	return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
}

/**
 * Smoothly scrolls the window so `el` lands at the vertical centre of the
 * viewport, over `duration` ms. Native `scrollIntoView({behavior:"smooth"})`
 * can't be slowed down — the browser picks its own (fairly brisk) timing —
 * so paging through the record panel needs its own rAF-driven tween instead.
 */
function smoothScrollCenterTo(el: HTMLElement, duration: number): void {
	const startY = window.scrollY;
	const rect = el.getBoundingClientRect();
	const targetY = startY + rect.top + rect.height / 2 - window.innerHeight / 2;
	const delta = targetY - startY;
	if (Math.abs(delta) < 1) return;
	const startTime = performance.now();
	function step(now: number) {
		// Clamp the low end too, not just `t <= 1` — a rAF callback's `now` can
		// land *before* `startTime` (it reflects when that frame began, which
		// can precede a `performance.now()` call made moments earlier in the
		// same commit/effect), making the first frame's `t` slightly negative.
		// `easeInOutExpo` isn't defined for negative input — it overshoots
		// backwards — so an unclamped `t` here jerks the scroll away from the
		// target for one frame before snapping back toward it.
		const t = Math.min(1, Math.max(0, (now - startTime) / duration));
		window.scrollTo(0, startY + delta * easeInOutExpo(t));
		if (t < 1) requestAnimationFrame(step);
	}
	requestAnimationFrame(step);
}

// How much of the remaining distance to the spotlight's target the eased
// position closes each animation frame — lower reads as laggier/dreamier,
// higher snaps closer to instant (1 would be the old 1:1 tracking).
const SPOTLIGHT_EASE = 0.09;
// Below this many px from the target, the eased position just snaps the
// rest of the way and the animation loop stops — otherwise it'd tick
// forever, asymptotically approaching but never quite reaching it.
const SPOTLIGHT_SETTLE_PX = 0.5;

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
 * plus `decoding="async"` on covers, and `content-visibility: auto` on each
 * tile's cover wrapper (see `RecordTile` below) — applying it to the *whole*
 * tile was tried once and reverted: it implies `contain: paint`, which clips
 * a tile's descendants to its own box and defeats the vinyl disc's deliberate
 * peek past the tile's edge (see `.vinyl-peek` in styles.css). Scoped to just
 * the cover's own `overflow-hidden` wrapper instead — a sibling of the disc,
 * not an ancestor — it gets the same win (measured via a real iOS Simulator
 * scroll: worst frame ~120ms → ~20-40ms, main-thread long tasks stayed at
 * zero throughout, so the cost was decode/style/layout work the browser can
 * now skip for offscreen tiles, not JS) without touching the peek at all.
 *
 * On touch devices (`useIsTouchDevice`), hover's whole job — which tile is
 * "active", and where the spotlight backdrop sits — is instead driven by
 * scroll (an `IntersectionObserver` watching a thin band through the
 * viewport's centre) plus device tilt (a small nudge on top of the active
 * tile's own position, since there's no cursor to place the spotlight at).
 *
 * Both touch and desktop share one "active tile" concept (`activeId` below)
 * and one shared, fixed bottom bar (`NowShowing`) showing its title/artist —
 * touch writes to it via the scroll observer, desktop via a plain pointer
 * hover. Neither anchors anything to the tile itself (no per-tile popover),
 * so nothing has to reposition or dismiss as the page scrolls.
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
	// before it opened. Also pins that tile "active" (see `RecordTile`) and
	// the spotlight over it, since the panel covering the pointer means
	// nothing would otherwise be hovered.
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

	// Keeps the grid scrolled to whichever record the detail panel has open —
	// on the initial open (grid click, or a direct nav to `/records/<id>-…`)
	// as well as while paging prev/next inside it — so closing the panel
	// never leaves you scrolled back to wherever you were before it opened,
	// and a direct-linked record is never left off-screen underneath. The
	// very first run (mount) warps straight there instead of animating: the
	// page can still be settling layout (fonts, images) right after load, and
	// animating over that would read as a stutter rather than a glide. Every
	// later change (grid click, paging) gets the smooth tween — the panel
	// covers most of the viewport but not all of it, so the motion is
	// visible at the edges and should read as deliberate rather than a snap.
	const prevFocusedIdRef = useRef<number | null>(null);
	const isFirstScrollRunRef = useRef(true);
	useEffect(() => {
		const prevFocusedId = prevFocusedIdRef.current;
		const isFirstRun = isFirstScrollRunRef.current;
		isFirstScrollRunRef.current = false;
		prevFocusedIdRef.current = focusedRecordId ?? null;
		if (
			focusedRecordId == null ||
			prevFocusedId === focusedRecordId ||
			!gridElRef.current
		) {
			return;
		}
		const el = gridElRef.current.querySelector<HTMLElement>(
			`[data-record-id="${focusedRecordId}"]`,
		);
		if (!el) return;
		if (prefersReducedMotionRef.current || isFirstRun) {
			el.scrollIntoView({ block: "center", behavior: "auto" });
		} else {
			smoothScrollCenterTo(el, GRID_SCROLL_DURATION_MS);
		}
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
	// Whether the spotlight has ever been given a real position (desktop
	// pointermove, or mobile's active-tile placement) — see `setSpotlightTarget`
	// and the desktop scroll-recompute effect further down. Both refs above
	// start at the arbitrary (0,0) origin; without this flag (a) the very
	// first real position chases there FROM (0,0) — invisible normally since
	// the overlay is still fading in from opacity 0 at the same time, but a
	// visible swoop if the overlay's already fully visible (see next point),
	// and (b) the scroll-recompute effect would trust (0,0) as a real
	// last-known cursor position before any pointer event had actually fired
	// — e.g. load the page and scroll via trackpad without ever moving the
	// mouse: the browser's own `:hover` still re-targets on scroll (no JS
	// event required), so the grid-focus-overlay correctly blurs/highlights
	// off real `:hover`, but this component's own "active" tracking has no
	// event to key off and was falling back to whatever tile sits at literal
	// viewport (0,0) instead — a phantom activation disconnected from what
	// `:hover` was actually showing.
	const hasPositionedRef = useRef(false);

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
			const firstPosition = !hasPositionedRef.current;
			hasPositionedRef.current = true;
			// First-ever position, or reduced motion: jump straight to the target
			// instead of chasing it frame by frame from the (0,0) default — the
			// whole point of the eased rAF loop is the chase, but chasing from an
			// origin that was never a real position is just a glitch, not motion.
			if (firstPosition || prefersReducedMotionRef.current) {
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

	// Marks the grid `data-scrolling="true"` for the duration of a scroll
	// gesture (plus a short settle window after it stops) — see `.collection-grid[data-scrolling="true"]`
	// in styles.css, which pauses the notes dot's infinite glow animation and
	// drops the cover's grayscale↔colour `filter` transition to an instant
	// snap for as long as this is set. Both are continuously-recomposited
	// GPU work (`filter`/`blur()` far more so than plain `transform`/`opacity`)
	// that a profiled Chrome CPU trace didn't surface — that trace measures
	// main-thread JS, not compositor/GPU cost, and a real iOS device's GPU is
	// far more constrained than a desktop one. With ~300 tiles mounted at
	// once (no virtualization — see the module doc above for why), any of
	// them mid-transition/animation during a scroll adds up. Written straight
	// to the DOM, not React state, for the same reason the spotlight position
	// and `data-pointer-outside` are — this never needs to trigger a re-render.
	useEffect(() => {
		const container = gridElRef.current;
		if (!container) return;
		let settleTimeout: number | null = null;
		const onScroll = () => {
			container.setAttribute("data-scrolling", "true");
			if (settleTimeout != null) window.clearTimeout(settleTimeout);
			settleTimeout = window.setTimeout(() => {
				container.removeAttribute("data-scrolling");
				settleTimeout = null;
			}, 200);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			window.removeEventListener("scroll", onScroll);
			if (settleTimeout != null) window.clearTimeout(settleTimeout);
		};
	}, []);

	const activeRecord = useMemo(
		() => records.find((r) => r.id === activeId) ?? null,
		[records, activeId],
	);

	// Keeps showing the last-active record's content while `NowShowing` fades
	// out — `activeRecord` itself goes null the instant nothing's hovered/
	// centred, which would otherwise blank the bar before its own opacity
	// transition finishes. Same trick `collection-view.tsx` uses to keep the
	// record panel's body rendered through its own close animation.
	const lastActiveRecordRef = useRef<PublicRecord | null>(null);
	if (activeRecord) lastActiveRecordRef.current = activeRecord;

	// The pinned tile's on-screen centre is the spotlight's base position
	// whenever there's no cursor to place it at directly — the record the
	// detail panel currently has open (the panel covers the pointer, so a
	// real hover can't). The grid-focus-overlay this drives is desktop-only
	// (see its `!isTouch` guard below — touch never gets the pointer-fine
	// hover this is meant to spotlight, and keeping its blur/rAF chase alive
	// on scroll was a real contributor to iOS Safari scroll jank), so this no
	// longer has a touch-only branch. Recomputed whenever the pinned tile
	// changes, and again on scroll since the *tile* stays pinned across a
	// scroll (or the panel's own prev/next glide) but its on-screen position
	// doesn't.
	const spotlightRecordId = focusedRecordId ?? null;
	const activeCenterRef = useRef({ x: 0, y: 0 });

	const recomputeActiveCenter = useCallback(() => {
		if (spotlightRecordId == null || !gridElRef.current) return;
		const el = gridElRef.current.querySelector<HTMLElement>(
			`[data-record-id="${spotlightRecordId}"]`,
		);
		if (!el) return;
		const rect = el.getBoundingClientRect();
		activeCenterRef.current = {
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		};
		setSpotlightTarget(activeCenterRef.current.x, activeCenterRef.current.y);
	}, [spotlightRecordId, setSpotlightTarget]);

	useEffect(() => {
		recomputeActiveCenter();
	}, [recomputeActiveCenter]);

	useEffect(() => {
		if (spotlightRecordId == null) return;
		// rAF-throttled — scroll fires far faster than a `getBoundingClientRect`
		// read needs to keep up with, and reading layout on every event risks
		// forcing a synchronous layout mid-scroll. Also covers the panel's own
		// programmatic prev/next glide (`smoothScrollCenterTo` above), which
		// fires the same `scroll` event, so the spotlight tracks the tile as
		// it moves instead of arriving already-settled at the old position.
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
	}, [spotlightRecordId, recomputeActiveCenter]);

	// --- Desktop: keep the active tile in sync with the cursor while
	// scrolling. A wheel/trackpad scroll moves the page under a stationary
	// cursor without firing any pointer event, so the per-tile `onPointerEnter`
	// that normally drives `activeId` never sees a tile scroll out from under
	// it — without this, `NowShowing` would keep showing whichever record was
	// last actually entered, arbitrarily stale once scrolling moves on.
	// `targetRef` already holds the last real `clientX/Y` from `onPointerMove`
	// (see the spotlight tracking above), so re-deriving from
	// `elementFromPoint` at that fixed screen position is the same trick
	// mobile's `recomputeActiveCenter` uses in reverse (there the tile is
	// fixed and its on-screen position is re-measured; here the screen
	// position is fixed and the tile underneath it is re-measured).
	useEffect(() => {
		if (isTouch) return;
		let ticking = false;
		const onScroll = () => {
			// No real pointermove has fired yet — `targetRef` is still its (0,0)
			// default, not a real last-known cursor position (see the comment on
			// `hasPositionedRef`). Trusting it here would activate whatever tile
			// happens to sit at literal viewport (0,0), disconnected from
			// wherever `:hover` (which the browser keeps correctly re-targeted on
			// scroll with no event needed) is actually showing.
			if (ticking || !hasPositionedRef.current) return;
			ticking = true;
			requestAnimationFrame(() => {
				ticking = false;
				const { x, y } = targetRef.current;
				const el = document
					.elementFromPoint(x, y)
					?.closest<HTMLElement>("[data-record-id]");
				setActiveId(el ? Number(el.dataset.recordId) : null);
			});
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, [isTouch]);

	return (
		<div
			ref={gridElRef}
			className="collection-grid"
			style={gridStyle}
			onPointerMove={
				isTouch
					? undefined
					: (e) => {
							// Covers a gap `onPointerEnter` (below) misses: the record
							// panel sliding over the grid triggers a real `pointerleave`
							// (the panel is now what's under the cursor), setting
							// `data-pointer-outside`. Closing the panel doesn't itself
							// fire `pointerenter` to clear it — browsers only recompute
							// hover targets on actual pointer movement across a boundary,
							// not just because an overlapping element left the DOM — so
							// without this, the very first gap-hop after closing the
							// panel stays stuck on the quick fade instead of the long
							// inter-tile linger. Any move over the grid is proof the
							// pointer is inside it, so clear it here too.
							if (e.currentTarget.hasAttribute("data-pointer-outside")) {
								e.currentTarget.removeAttribute("data-pointer-outside");
							}
							setSpotlightTarget(e.clientX, e.clientY);
						}
			}
			// `data-pointer-outside` (see `.grid-focus-overlay` in styles.css) tells
			// the overlay's fade-out whether the pointer left the whole grid or just
			// hopped the gap between two tiles — `onPointerLeave`/`Enter` (unlike
			// `onPointerMove`) don't fire for that inner hop since they're the
			// non-bubbling enter/leave pair, only the outer boundary crossing. Written
			// straight to the DOM rather than React state — same reasoning as the
			// spotlight position above, this never needs to trigger a re-render.
			// Leaving the grid entirely is also the desktop equivalent of mobile's
			// "scrolled past every tile" — clears `activeId` so `NowShowing`
			// unmounts instead of showing a stale record. Hopping the gap *between*
			// two tiles never fires this (see above), so the bar just swaps
			// straight to the newly-entered tile without flickering off first.
			onPointerLeave={
				isTouch
					? undefined
					: (e) => {
							e.currentTarget.setAttribute("data-pointer-outside", "true");
							setActiveId(null);
						}
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
					active={
						record.id === focusedRecordId ||
						(isTouch && focusedRecordId == null && record.id === activeId)
					}
					onActivate={isTouch ? undefined : setActiveId}
				/>
			))}
			{/* Shared hover backdrop for every tile — see `.grid-focus-overlay` in
			    styles.css. `position: fixed` excludes it from the grid's own auto-
			    placement (an in-flow child here would otherwise consume a cell).
			    Masked to a radial gradient centred on the eased spotlight position
			    above (`--overlay-x/y`) so the blur opens up right where the
			    cursor/active tile is instead of snapping between "sharp tile" and
			    "blurred everything else" with nothing in between. Desktop-only —
			    touch gets `.grid-focus-overlay-static` below instead, since a
			    continuous rAF chase feeding this element's mask position (to
			    track a cursor that doesn't exist on touch) was a real contributor
			    to iOS Safari scroll jank. */}
			{!isTouch && (
				<div
					ref={overlayRef}
					aria-hidden="true"
					className="grid-focus-overlay pointer-events-none fixed inset-0 bg-white/50 opacity-0 backdrop-blur-sm dark:bg-black/50"
				/>
			)}
			{/* Touch's version of the same vignette — see
			    `.grid-focus-overlay-static` in styles.css. No ref, no pointer/scroll
			    listeners: the hole is pinned to the viewport centre in CSS alone,
			    so this needs nothing from JS beyond the `data-active`/
			    `data-pointer-outside` attributes `RecordTile`/the IntersectionObserver
			    band-tracking above already maintain for other reasons. */}
			{isTouch && (
				<div
					aria-hidden="true"
					className="grid-focus-overlay-static pointer-events-none fixed inset-0 bg-white/50 opacity-0 backdrop-blur-sm dark:bg-black/50"
				/>
			)}
			{lastActiveRecordRef.current && (
				<NowShowing
					record={lastActiveRecordRef.current}
					visible={activeRecord != null}
					isTouch={isTouch}
				/>
			)}
		</div>
	);
}

/**
 * One shared bar fixed to the bottom of the viewport, showing whichever
 * record `CollectionGrid` currently considers "active" (scroll-driven on
 * touch, hover-driven on desktop) — see the comment on `CollectionGrid`.
 * Deliberately plain text, no `.title-palette` gradient — it swaps records as
 * fast as the user scrolls/hovers, and re-parsing a palette gradient into a
 * fixed bar that often isn't worth it for a label only ever on screen a
 * moment.
 *
 * `visible` drives a plain opacity transition rather than a mount/unmount —
 * `record` is always the *last* active one (see `lastActiveRecordRef` in
 * `CollectionGrid`), so when `visible` goes false this keeps rendering that
 * same content fading out instead of blanking instantly.
 */
function NowShowing({
	record,
	visible,
	isTouch,
}: {
	record: PublicRecord;
	visible: boolean;
	isTouch: boolean;
}) {
	return (
		<div
			className={cn(
				"pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 transition-opacity duration-300 ease-out motion-reduce:transition-none",
				visible ? "opacity-100" : "opacity-0",
			)}
		>
			<div
				className={cn(
					"flex max-w-[calc(100%-2rem)] flex-col items-center gap-0.5 rounded-md border bg-popover/95 px-4 py-2 text-center text-popover-foreground shadow-lg",
					// `backdrop-blur` is a real GPU cost kept alive for as long as this
					// bar is visible — on touch this bar is up for essentially the
					// whole time you're scrolling, so on iOS Safari that's a
					// continuously-composited blur under a constantly repositioned
					// fixed element. `bg-popover/95` is already close to opaque, so
					// the blur was buying very little there anyway.
					!isTouch && "backdrop-blur-sm",
				)}
			>
				<p className="text-balance font-serif text-base font-medium leading-tight">
					{/* Same "has notes" signal as the tile's own corner dot — the
					    corner dot fades out on hover/active, so this is the only
					    place the signal survives once you're actually looking at
					    the record. A plain inline `<span>` (not a flex item) so it
					    sits inline with the title text — a flex row here previously
					    pinned it to the bar's left edge instead of against the text
					    it's meant to badge. */}
					{hasNotes(record) && (
						<span className="mr-1.5 inline-block size-1.5 rounded-full bg-brand align-middle" />
					)}
					{record.title}
				</p>
				<p className="font-mono text-muted-foreground text-xs">
					{record.artist}
				</p>
			</div>
		</div>
	);
}
