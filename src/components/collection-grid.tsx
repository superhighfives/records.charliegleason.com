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
 * Wrapped in `memo` — `CollectionGrid` re-renders on scroll-driven state
 * changes on touch (`activeId`, the content window), and without this every
 * one of the (currently ~300) tiles would re-render along with it even
 * though at most a handful actually have a changed prop. That was the
 * dominant cost behind the iOS scroll jank this was chasing — a profiled
 * scroll showed React's `performWorkUntilDeadline` alone eating ~4s of
 * main-thread time across a 4s scroll.
 *
 * On touch (`isTouch`), the tile's *content* is windowed: `contentMounted`
 * false swaps the cover/disc subtree for a cheap static placeholder circle
 * while the outer grid slot (same span, same square box) stays mounted, so
 * dense auto-flow placement — which depends on every earlier child — never
 * changes as the window moves. See the windowing comment in
 * `CollectionGrid`. The touch variant also drops two desktop-only
 * mechanisms outright: the `[content-visibility:auto]` cover wrapper (a
 * windowed tile that's mounted should always be genuinely painted — the
 * async paint catch-up that attribute schedules is exactly the unobservable
 * clock the old touch effect kept losing races against) and the
 * `.disc-mask` circle (on touch the disc rests at opacity 0 and is faded in
 * by the ambient loop as it peeks, so there's no rest-state silhouette to
 * hide behind the alpha-transparent covers).
 */
const RecordTile = memo(function RecordTile({
	record,
	onOpen,
	spanning = false,
	active = false,
	onActivate,
	isTouch = false,
	contentMounted = true,
	onCoverReady,
}: {
	record: PublicRecord;
	onOpen: (record: PublicRecord) => void;
	spanning?: boolean;
	active?: boolean;
	onActivate?: (id: number | null) => void;
	isTouch?: boolean;
	/** Touch windowing — false renders the placeholder instead of the cover. */
	contentMounted?: boolean;
	/**
	 * Fires (post-commit) whenever this tile's cover becomes ready while its
	 * content is mounted — wakes the touch ambient loop so a cover that
	 * finishes decoding after scrolling has settled still gets its reveal,
	 * without the loop having to poll for it.
	 */
	onCoverReady?: () => void;
}) {
	const matte = displayMatteKey(record);
	const cover = matte ?? displayCoverKey(record);
	// Tiles stay near TILE_MIN_PX wide regardless of viewport (more columns get
	// added instead of individual tiles growing) — 500 covers a ~250px tile at
	// 2x without shipping the ~1MB master. A spanning (2×2) tile is roughly
	// double that, so it gets a correspondingly larger request.
	const coverSrc = cover ? photoUrl(cover, spanning ? 900 : 500) : undefined;
	// Desktop: fades the disc in behind the cover once it's up (see the
	// `VinylDisc` className below). Touch: read by the ambient loop as its
	// eligibility gate (`data-cover-ready` on the group) — a tile whose cover
	// hasn't actually loaded is never asked to animate, so a disc can't peek
	// out from behind a cover that isn't there. Seeded from `FadeImage`'s own
	// decoded-src cache so a cover the grid has already shown this session
	// (e.g. its content remounting as the touch window scrolls back over it)
	// counts as ready the instant it mounts, matching the fade the cover
	// itself skips.
	const [coverReady, setCoverReady] = useState(
		() => !cover || isImageDecoded(coverSrc),
	);
	// See `onCoverReady`'s prop comment. `contentMounted` is a dependency on
	// purpose: a remount of already-ready content (the window scrolling back
	// over this tile) needs to wake the loop too, not just the first-ever
	// decode.
	useEffect(() => {
		if (coverReady && contentMounted) onCoverReady?.();
	}, [coverReady, contentMounted, onCoverReady]);
	return (
		<div
			className="group"
			data-record-id={record.id}
			data-active={active ? "true" : undefined}
			data-cover-ready={coverReady ? "true" : undefined}
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
					{contentMounted ? (
						<>
							<VinylDisc
								colorName={record.colorName}
								textureImageKey={record.colorTextureImageKey}
								textureStatus={record.colorTextureStatus}
								translucent={record.colorTranslucent}
								size={record.size}
								discCount={record.discCount}
								className={
									// Touch: rests fully invisible — the ambient loop fades
									// it in (inline `opacity` on `.vinyl-peek`) in step with
									// the peek itself, so there's never a rest-state disc
									// silhouette showing through the alpha-transparent
									// covers, and nothing for a disc mask to hide. No
									// transition classes: the loop is the only easing (see
									// `[data-touch]` in styles.css). Desktop: kept faded
									// out until the cover is up, then revealed on a delay
									// so a slow first-ever load never flashes a bold disc
									// behind a not-yet-loaded cover.
									isTouch
										? "m-1/16 opacity-0"
										: cn(
												"m-1/16 transition-opacity duration-700 ease-out motion-reduce:transition-none delay-700",
												coverReady ? "opacity-100" : "opacity-0",
											)
								}
							/>
							{/* Desktop only: masks the disc's rest-state silhouette once
							    `coverReady` — the covers are alpha-transparent with ragged
							    edges (the whole collection is served via
							    `/api/photos/alpha/…`, `object-contain`), so without this
							    the resting disc shows through them constantly. A circle
							    matching the `inset-[5%] size-[90%]` box the disc's own
							    SVGs draw into, in `bg-background` so wherever it shows
							    through it reads as the page behind a transparent image
							    (which it is) rather than a distinct overlay. CSS clears
							    it on hover/pinned in step with the disc sliding out (see
							    `.disc-mask` in styles.css). Touch doesn't render it at
							    all — the disc rests at opacity 0 there instead (see the
							    `VinylDisc` className above), which is the whole reason
							    the touch path has no mask-timing races left to lose. */}
							{!isTouch && coverReady && (
								<div
									aria-hidden="true"
									className="disc-mask absolute inset-[5%] size-[90%] rounded-full bg-background"
								/>
							)}
							{/* Desktop keeps `content-visibility: auto` on the cover's own
							    wrapper (a sibling of the disc, so the peek is never
							    clipped by its implied `contain: paint`) — with all ~300
							    tiles' content permanently mounted there, letting the
							    browser skip offscreen covers is a real win. Touch
							    deliberately drops it: the content window below already
							    keeps only the few dozen near-viewport tiles mounted, and
							    a mounted tile being *always genuinely painted* is what
							    makes the ambient effect race-free — content-visibility's
							    async catch-up after a fast scroll-back was the
							    unobservable clock behind every prior artifact. Sized
							    purely by `inset-0` against the already-sized
							    `aspect-square` parent, so no `contain-intrinsic-size`
							    fallback is needed. */}
							<div
								className={cn(
									"absolute inset-0 overflow-hidden",
									!isTouch && "[content-visibility:auto]",
								)}
							>
								{/* Shown behind the cover while it loads — `-z-10` (rather
								    than unmounting once ready) so it never has to fight
								    FadeImage's own opacity for stacking order; the opaque
								    cover simply paints over it once revealed. Cover-less
								    tiles skip straight to the placeholder, so no skeleton
								    for those. Same circle as the windowing placeholder and
								    (desktop) disc mask, so every not-yet-content state
								    reads as one consistent affordance. */}
								{cover && !coverReady && (
									<Skeleton className="absolute inset-[5%] size-[90%] -z-10 rounded-full" />
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
											// active-only (the panel-pinned tile) — a gentle
											// zoom standing in for the pointer-driven spotlight
											// desktop gets instead. The parent's `overflow-hidden`
											// clips it, so it zooms in place rather than growing
											// the tile's footprint. Tailwind v4's `scale-*`
											// compiles to the native CSS `scale` property, not
											// `transform` — transitioning `transform` here would
											// silently do nothing to it. On touch, `[data-touch]`
											// in styles.css narrows the transition to opacity
											// only — filter/scale there are driven per-frame by
											// the ambient loop, whose easing a CSS transition
											// would smooth *again*, lagging it.
											"size-full grayscale transition-[opacity,filter,scale] duration-1000 ease-out pointer-fine:group-hover:grayscale-0 group-data-[active=true]:grayscale-0 group-data-[active=true]:scale-105",
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
						</>
					) : (
						// Windowed-out placeholder (touch only): the same circle the
						// loading skeleton uses, minus the pulse animation — it's only
						// ever glimpsed mid-fling, and ~250 of these are mounted at
						// once, so it must cost nothing to keep around. Static markup,
						// no image, no SVG, no animation.
						<div
							aria-hidden="true"
							className="absolute inset-[5%] size-[90%] rounded-full bg-muted/40"
						/>
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

// --- Touch scroll system: constants + pure helpers -------------------------
// (Used only by the touch effect in `CollectionGrid` — see its comment.)

// How far past the viewport (in viewport heights) tile content stays mounted
// on touch, in each direction. Generous enough that ordinary scrolling never
// catches the window's edge; a violent fling can outrun it, which shows the
// static placeholder circle for a beat — the honest loading affordance, and
// vastly cheaper than keeping all ~300 covers alive.
const WINDOW_MARGIN_VH = 1.5;
// How far the page must scroll (in viewport heights) before window membership
// is recomputed. Recomputing (and the React re-render it can trigger) a few
// times per screenful instead of every frame keeps the scroll loop itself
// allocation- and commit-free almost all the time; the margin above is wide
// enough that membership genuinely can't change meaningfully within one
// hysteresis step.
const WINDOW_HYSTERESIS_VH = 0.4;
// Tiles further than this (in viewport heights) from the viewport's centre
// aren't examined by the ambient pass at all. Deliberately generous — a tile
// outside `ambientProgress`'s own falloff reads as fully at rest regardless,
// so slack here costs only arithmetic.
const CANDIDATE_BAND_VH = 1.5;

// A tile used to reach full colour the *instant* it passed dead centre and
// immediately start fading again — dist===0 was a single point, not a range,
// so a linear `1 - dist/falloff` ramp reads as constantly easing in and out
// with no moment of "fully there". `AMBIENT_CORE_RATIO` carves out a flat
// plateau at the middle of the falloff radius — full colour for as long as a
// tile stays within it — and only the remaining outer band ramps at all, so
// the ramp itself reads as quick rather than gradual. A trapezoid, not a
// triangle. `AMBIENT_FALLOFF_RATIO` scales the falloff to the tile's *own*
// height, keeping the transition proportioned to row spacing rather than a
// fixed viewport constant that could span several rows of a dense grid.
const AMBIENT_FALLOFF_RATIO = 0.62;
const AMBIENT_CORE_RATIO = 0.75;
// The column crossfade's horizontal counterpart to `AMBIENT_FALLOFF_RATIO` —
// 1 fades a tile out exactly by the time its immediate neighbour's own slot
// centre is reached, so a row wider than 2 columns still never blends across
// more than its two nearest tiles at once.
const COLUMN_FALLOFF_RATIO = 1;
// `updateActive`'s targets are sampled once per frame — during a fast fling
// the scroll position can move several steps' worth of the steep trapezoid
// between two samples, so writing targets straight to the DOM read as a snap.
// Each tile's painted value chases its target by this fraction of the
// remaining distance per frame instead (the same pattern as the desktop
// spotlight's SPOTLIGHT_EASE), settling once within the epsilon.
const AMBIENT_PROGRESS_EASE = 0.35;
const AMBIENT_SETTLE_EPSILON = 0.01;
// The disc's opacity ramps in ahead of its slide — fully opaque by half the
// tile's progress — so it materialises while still mostly behind the cover
// and is solid by the time the peek is prominent, rather than a ghost disc
// sliding around. (On touch the disc rests at opacity 0; see `RecordTile`.)
const DISC_FADE_LEAD = 2;

// Shared trapezoid shape — flat plateau at `1` for `dist <= falloff *
// AMBIENT_CORE_RATIO`, linear ramp to `0` over the remaining outer band.
// `ambientProgress` uses this for the vertical falloff; the column crossfade
// (`colWeight` in the touch effect) uses the exact same shape so a multi-tile
// row gets the same "hold at full colour" dwell the vertical axis does.
function trapezoidWeight(dist: number, falloffDist: number): number {
	const corePx = falloffDist * AMBIENT_CORE_RATIO;
	if (dist <= corePx) return 1;
	return Math.max(0, Math.min(1, 1 - (dist - corePx) / (falloffDist - corePx)));
}

// Progress is a tile's own *centre* distance from the viewport's centre, not
// an edge-clipping metric — a tall 2×2 spanning tile has one well-defined
// centre point regardless of its height, so there's no "which edge is it
// near" ambiguity.
function ambientProgress(tileCenterY: number, tileHeight: number): number {
	const dist = Math.abs(tileCenterY - window.innerHeight / 2);
	return trapezoidWeight(dist, tileHeight * AMBIENT_FALLOFF_RATIO);
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
 * matter how large the batch. A single grid has no such boundary, and the
 * current touch windowing keeps it that way by never unmounting a grid
 * *child* at all — only each slot's content (see `RecordTile` and the touch
 * effect below), so auto-placement input is identical no matter where the
 * window sits.
 *
 * Desktop perf for the (currently few-hundred-record) collection comes from
 * `loading="lazy"` plus `decoding="async"` on covers, and `content-
 * visibility: auto` on each tile's cover wrapper — applying it to the
 * *whole* tile was tried once and reverted: it implies `contain: paint`,
 * which clips a tile's descendants to its own box and defeats the vinyl
 * disc's deliberate peek past the tile's edge (see `.vinyl-peek` in
 * styles.css). Scoped to just the cover's own `overflow-hidden` wrapper — a
 * sibling of the disc, not an ancestor — it gets the same win without
 * touching the peek. Touch gets real content windowing instead and drops
 * content-visibility entirely; see the touch effect below for why.
 *
 * On touch devices (`useIsTouchDevice`), hover's whole job — which tile is
 * "active", plus the grayscale→colour/scale/disc-peek reveal — is driven by
 * one scroll-fed rAF loop (the touch effect below). Both touch and desktop
 * share one "active tile" concept (`activeId` below) and one shared, fixed
 * bottom bar (`NowShowing`) showing its title/artist — touch writes to it
 * from the scroll loop, desktop via a plain pointer hover. Neither anchors
 * anything to the tile itself (no per-tile popover), so nothing has to
 * reposition or dismiss as the page scrolls.
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

	// --- Shared "active tile" state (NowShowing's content) -------------------
	const [activeId, setActiveId] = useState<number | null>(null);

	// `?perf` — dev-only frame meter (see `PerfMeter` below). Read in an
	// effect, not during render, so SSR and first client render stay
	// identical for hydration.
	const [showPerf, setShowPerf] = useState(false);
	useEffect(() => {
		setShowPerf(new URLSearchParams(window.location.search).has("perf"));
	}, []);

	// --- Touch: windowed content + one-clock scroll system -------------------
	// Which records currently have their full tile content (cover, discs)
	// mounted — `null` means all of them (desktop, and touch before its first
	// measurement). Written by the touch effect below; a tile outside the
	// window renders a static placeholder instead (see `RecordTile`).
	const [mountedIds, setMountedIds] = useState<Set<number> | null>(null);
	// Lets tile content wake the touch loop without a scroll event — a cover
	// finishing its decode (or remounting already-decoded) after scrolling has
	// settled still needs one more pass so its reveal can play. Routed through
	// a ref so the callback handed to every tile stays referentially stable
	// for `memo`.
	const requestTickRef = useRef<(() => void) | null>(null);
	const handleCoverReady = useCallback(() => requestTickRef.current?.(), []);

	// The touch scroll system. One rAF loop is the *only* clock: it computes
	// window membership, the active tile, and every tile's ambient progress
	// (grayscale→colour, scale, disc peek + disc opacity), easing each painted
	// value toward its target and writing styles directly to the DOM. Nothing
	// else — no CSS transition (see `[data-touch]` in styles.css), no React
	// state, no content-visibility catch-up, no IntersectionObserver delivery
	// — participates in the per-frame animation, which is the load-bearing
	// design decision: the previous incarnation had five independent timing
	// systems that could not observe each other, and every artifact it ever
	// produced came down to two of them disagreeing about a tile's state.
	//
	// Layout is read in exactly two places: a one-batch measurement of every
	// tile (`measure`, re-run only when layout can actually change — records,
	// container resize) and a single container rect per frame to convert the
	// cached offsets to viewport space. The per-frame work is pure arithmetic
	// over ~300 cached entries plus style writes on the handful of tiles near
	// the centre — no forced layout, no allocation churn, no querySelectorAll.
	//
	// `records` isn't read in the effect body, but a records change means new
	// tile elements in the DOM that need measuring, so the effect must re-run.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (!isTouch || !gridElRef.current) return;
		const container = gridElRef.current;

		type TileInfo = {
			el: HTMLElement;
			id: number;
			/** Offsets from the grid container's own top/left edge. */
			top: number;
			left: number;
			width: number;
			height: number;
		};
		let tiles: TileInfo[] = [];
		const tileById = new Map<number, TileInfo>();
		// Container-relative scroll offset at the last window recompute.
		// Infinity forces `updateWindow` on the next tick regardless of
		// hysteresis (fresh measurement = membership must be recomputed).
		let lastWindowTop = Infinity;

		function measure() {
			const containerRect = container.getBoundingClientRect();
			tiles = [];
			tileById.clear();
			for (const el of container.querySelectorAll<HTMLElement>(
				"[data-record-id]",
			)) {
				const r = el.getBoundingClientRect();
				const info: TileInfo = {
					el,
					id: Number(el.dataset.recordId),
					top: r.top - containerRect.top,
					left: r.left - containerRect.left,
					width: r.width,
					height: r.height,
				};
				tiles.push(info);
				tileById.set(info.id, info);
			}
			lastWindowTop = Infinity;
		}

		function updateWindow(scrollTop: number) {
			const margin = window.innerHeight * WINDOW_MARGIN_VH;
			const windowTop = scrollTop - margin;
			const windowBottom = scrollTop + window.innerHeight + margin;
			const next = new Set<number>();
			for (const t of tiles) {
				if (t.top < windowBottom && t.top + t.height > windowTop) {
					next.add(t.id);
				}
			}
			// Only commit genuinely different membership — the hysteresis in
			// `tick` already throttles how often this runs, and returning the
			// previous set when nothing changed skips the React render entirely.
			setMountedIds((prev) => {
				if (prev && prev.size === next.size) {
					let same = true;
					for (const id of next) {
						if (!prev.has(id)) {
							same = false;
							break;
						}
					}
					if (same) return prev;
				}
				return next;
			});
		}

		// A tile near the viewport centre this frame — `top`/`bottom` are
		// viewport-relative, derived from the cached container-relative offsets.
		type Candidate = { info: TileInfo; top: number; bottom: number };

		// Which tile is "active" (NowShowing's content), and the target
		// highlight weight for each tile in the active row. Several tiles can
		// share the centre band at once (a wide row): whichever gets picked is
		// decided by where the viewport's vertical centre currently falls
		// within *that row's* own height — at the row's top edge the leftmost
		// tile, at the bottom edge the rightmost, sweeping left-to-right in
		// between — so a single continuous scroll walks the whole collection
		// tile by tile, not row by row.
		function updateActive(candidates: Candidate[]): Map<number, number> {
			const centerY = window.innerHeight / 2;
			const bandHalfPx = window.innerHeight * 0.05;
			const inBand = candidates.filter(
				(c) => c.top < centerY + bandHalfPx && c.bottom > centerY - bandHalfPx,
			);
			const highlights = new Map<number, number>();
			let next: number | null = null;
			if (inBand.length > 0) {
				// The band can briefly hold tiles from two different rows at once
				// (one row exiting as the next enters), and a 2×2 spanning tile
				// vertically overlaps *two* ordinary rows — mixing those rects
				// together threw the row fraction (and the picked tile) around
				// wildly. Anchor on whichever tile's centre is closest to the
				// centre line, then only treat tiles that overlap it *and* are
				// roughly the same size — same row, same size class — as the row.
				const anchor = inBand.reduce((closest, entry) => {
					const dist = Math.abs((entry.top + entry.bottom) / 2 - centerY);
					const closestDist = Math.abs(
						(closest.top + closest.bottom) / 2 - centerY,
					);
					return dist < closestDist ? entry : closest;
				});
				const anchorHeight = anchor.bottom - anchor.top;
				const row = inBand
					.filter((c) => {
						const overlaps = c.top < anchor.bottom && c.bottom > anchor.top;
						const h = c.bottom - c.top;
						const sameSize = h / anchorHeight > 0.5 && h / anchorHeight < 1.5;
						return overlaps && sameSize;
					})
					.sort((a, b) => a.info.left - b.info.left);
				// The leftmost/rightmost tiles nudge the row's top/bottom by 1px
				// (left up, right down) before the fraction split below. CSS Grid
				// rounds fractional column widths independently per cell, so two
				// side-by-side tiles can have sub-pixel-different bounds — a
				// scroll position dead-centre on the pair could floor to
				// whichever tile's rect rounded a hair short, highlighting one
				// tile while opening the other. This breaks the tie in the
				// direction it was observed to land wrong.
				const rowTop = Math.min(
					...row.map((c, i) => c.top + (i === 0 ? -1 : 0)),
				);
				const rowBottom = Math.max(
					...row.map((c, i) => c.bottom + (i === row.length - 1 ? 1 : 0)),
				);
				const fraction =
					rowBottom > rowTop ? (centerY - rowTop) / (rowBottom - rowTop) : 0;
				const index = Math.min(
					row.length - 1,
					Math.max(0, Math.floor(fraction * row.length)),
				);
				next = row[index].info.id;

				// NowShowing hard-switches at `index`'s boundary, but the visual
				// highlight shouldn't — every tile in the row shares the same
				// vertical distance from centre, so a discrete flip right at the
				// falloff's peak reads as a snap. Blend across columns with the
				// same trapezoid the vertical axis uses: each tile's share of
				// the row's vertical progress fades in as `fraction` approaches
				// its column's centre and out toward its neighbours'.
				const rowCenterY = (rowTop + rowBottom) / 2;
				const verticalProgress = ambientProgress(rowCenterY, anchorHeight);
				const slotWidth = 1 / row.length;
				for (let i = 0; i < row.length; i++) {
					// A "row" of exactly one tile (typically a 2×2 spanning tile
					// with no same-size neighbour) has nothing to blend against —
					// attenuating a lone tile toward 0 near the ends of its own
					// span just disagreed with the unattenuated natural-progress
					// value computed for the same tile the instant it stopped
					// being the anchor, which read as flicker right at that
					// boundary.
					const colWeight =
						row.length === 1
							? 1
							: trapezoidWeight(
									Math.abs(fraction - (i + 0.5) * slotWidth),
									slotWidth * COLUMN_FALLOFF_RATIO,
								);
					highlights.set(row[i].info.id, verticalProgress * colWeight);
				}
			}
			setActiveId(next);
			return highlights;
		}

		// Everything a frame writes is computed from inline data (the CSS vars
		// React sets on the disc elements) plus the cached tile width — writing
		// a frame never reads layout.
		function applyAmbient(info: TileInfo, progress: number) {
			const el = info.el;
			const img = el.querySelector<HTMLImageElement>("img");
			if (img) {
				img.style.filter = `grayscale(${1 - progress})`;
				img.style.scale = String(1 + 0.05 * progress);
			}
			const peek = el.querySelector<HTMLElement>(".vinyl-peek");
			if (peek) {
				peek.style.opacity = String(Math.min(1, progress * DISC_FADE_LEAD));
				const layers =
					Number(peek.style.getPropertyValue("--vinyl-layers")) || 1;
				const vinylScale =
					Number(peek.style.getPropertyValue("--vinyl-scale")) || 1;
				// `.vinyl-disc` renders at `size-[90%]` of the tile.
				const discWidth = info.width * 0.9;
				for (const disc of peek.querySelectorAll<SVGSVGElement>(
					".vinyl-disc",
				)) {
					const stackIndex =
						Number(disc.style.getPropertyValue("--vinyl-stack-index")) || 0;
					// Same shape as desktop's `.group:hover .vinyl-disc` rule in
					// styles.css (see its comment for the min()/stack math), with
					// `progress` sweeping rest → full reveal.
					const maxTx =
						Math.min(discWidth * 0.25, 64) * vinylScale -
						8 * (layers - 1 - stackIndex);
					const restRotate = 3 * stackIndex;
					const peakRotate = 6 - 3 * (layers - 1 - stackIndex);
					disc.style.transform = `translateX(${maxTx * progress}px) scale(${1 + 0.06 * progress}) rotate(${restRotate + (peakRotate - restRotate) * progress}deg)`;
				}
			}
			// Matches hover/pinned `z-index: 10` (see `.vinyl-peek` in
			// styles.css) so the peeking disc paints over the next cell in DOM
			// order instead of under it.
			el.style.zIndex = "10";
		}

		function clearAmbient(info: TileInfo) {
			const el = info.el;
			const img = el.querySelector<HTMLImageElement>("img");
			if (img) {
				img.style.filter = "";
				img.style.scale = "";
			}
			const peek = el.querySelector<HTMLElement>(".vinyl-peek");
			if (peek) {
				peek.style.opacity = "";
				for (const disc of peek.querySelectorAll<SVGSVGElement>(
					".vinyl-disc",
				)) {
					disc.style.transform = "";
				}
			}
			el.style.zIndex = "";
		}

		const ambientCurrent = new Map<number, number>();
		let rafId: number | null = null;

		function tick() {
			rafId = null;
			// The only per-frame layout read: where the grid sits in the
			// viewport right now. Converts every cached offset to viewport
			// space, and automatically absorbs anything above the grid changing
			// height.
			const containerTop = container.getBoundingClientRect().top;
			const vh = window.innerHeight;
			const centerY = vh / 2;
			const scrollTop = -containerTop;

			if (Math.abs(scrollTop - lastWindowTop) > vh * WINDOW_HYSTERESIS_VH) {
				lastWindowTop = scrollTop;
				updateWindow(scrollTop);
			}

			const band = vh * CANDIDATE_BAND_VH;
			const candidates: Candidate[] = [];
			for (const t of tiles) {
				const top = containerTop + t.top;
				const bottom = top + t.height;
				if (bottom < centerY - band || top > centerY + band) continue;
				candidates.push({ info: t, top, bottom });
			}

			const targets = updateActive(candidates);

			// `updateActive` (via `setActiveId`) drives NowShowing's content —
			// not itself motion, so it still runs under reduced motion.
			// Everything below is the ambient animation, which reduced motion
			// skips entirely.
			if (prefersReducedMotionRef.current) return;

			// `targets` only has entries for the anchor's own row — every other
			// candidate falls to 0 the instant it stops being that row,
			// regardless of how close it still is. Invisible for a normal tile
			// (its own falloff has already faded it out by then) but a real
			// jump for a 2×2 spanning tile, whose taller falloff radius keeps
			// it substantially lit when a neighbouring row takes over. Filling
			// in each non-row tile's own natural progress lets it decay on its
			// own continuous curve instead.
			for (const c of candidates) {
				if (targets.has(c.info.id)) continue;
				const natural = ambientProgress(
					(c.top + c.bottom) / 2,
					c.bottom - c.top,
				);
				if (natural > 0) targets.set(c.info.id, natural);
			}

			let stillEasing = false;
			const ids = new Set<number>([
				...targets.keys(),
				...ambientCurrent.keys(),
			]);
			for (const id of ids) {
				const info = tileById.get(id);
				if (!info) {
					ambientCurrent.delete(id);
					continue;
				}
				// The record panel's pinned tile is a discrete "this one
				// specifically" state, shown by CSS's own `[data-active="true"]`
				// rules — clear the inline styles this loop wrote (they beat the
				// CSS on specificity) so the pinned look shows through, and
				// freeze the eased value at 1 (matching that look) so easing
				// resumes from where the tile visually was when it unpins,
				// instead of wherever it silently drifted.
				if (info.el.dataset.active === "true") {
					ambientCurrent.set(id, 1);
					clearAmbient(info);
					continue;
				}
				let target = targets.get(id) ?? 0;
				// The settled-gate: a tile is only eligible to animate once its
				// cover has actually decoded (`data-cover-ready`, written by
				// React state whose commit *is* the paint on this path — no
				// content-visibility means no async catch-up to race). Until
				// then it rests, whatever its distance says — a disc must never
				// peek out from behind a cover that isn't there. The eased
				// approach below turns the gate opening into a fade-in, not a
				// pop.
				if (target > 0 && info.el.dataset.coverReady !== "true") target = 0;
				const current = ambientCurrent.get(id) ?? 0;
				const delta = target - current;
				let next: number;
				if (Math.abs(delta) < AMBIENT_SETTLE_EPSILON) {
					next = target;
				} else {
					next = current + delta * AMBIENT_PROGRESS_EASE;
					stillEasing = true;
				}
				if (next <= 0) {
					ambientCurrent.delete(id);
					if (current !== 0) clearAmbient(info);
				} else {
					ambientCurrent.set(id, next);
					applyAmbient(info, next);
				}
			}
			// Keep ticking only while something is still easing — scroll events
			// (and `requestTickRef` wake-ups) restart the loop otherwise.
			if (stillEasing) rafId = requestAnimationFrame(tick);
		}

		const schedule = () => {
			if (rafId == null) rafId = requestAnimationFrame(tick);
		};
		requestTickRef.current = schedule;

		measure();
		tick();

		window.addEventListener("scroll", schedule, { passive: true });
		// iOS URL-bar collapse/expand changes the viewport height without
		// relayouting the grid — no re-measure needed, but centre/window math
		// shift, so re-run the loop.
		window.addEventListener("resize", schedule);
		// Width/column-count changes DO relayout the grid: re-measure. Also
		// fires once right after `observe`, which harmlessly repeats the
		// explicit initial `measure()` above.
		const resizeObserver = new ResizeObserver(() => {
			measure();
			schedule();
		});
		resizeObserver.observe(container);

		return () => {
			requestTickRef.current = null;
			if (rafId != null) cancelAnimationFrame(rafId);
			window.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			resizeObserver.disconnect();
			// Don't leave half-applied inline styles behind for the desktop
			// variant (or a fresh run of this effect) to inherit.
			for (const id of ambientCurrent.keys()) {
				const info = tileById.get(id);
				if (info) clearAmbient(info);
			}
		};
	}, [isTouch, records]);

	// Marks the grid `data-scrolling="true"` for the duration of a scroll
	// gesture (plus a short settle window after it stops) — see `.collection-grid[data-scrolling="true"]`
	// in styles.css, which pauses the notes dot's infinite glow animation and
	// (desktop) drops the cover's grayscale↔colour `filter` transition to an
	// instant snap for as long as this is set. Both are continuously-
	// recomposited GPU work (`filter`/`blur()` far more so than plain
	// `transform`/`opacity`) that a profiled Chrome CPU trace didn't surface —
	// that trace measures main-thread JS, not compositor/GPU cost. Matters
	// most on desktop, where all ~300 tiles stay mounted; on touch the content
	// window keeps the mounted-dot population small, but pausing the handful
	// left is still free. Written straight to the DOM, not React state, for
	// the same reason the spotlight position and `data-pointer-outside` are —
	// this never needs to trigger a re-render.
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
			// Switches CSS to the touch variant (see `[data-touch]` in
			// styles.css): transitions come off every property the touch loop
			// drives per-frame, so CSS smoothing never re-eases (= lags) the
			// loop's own easing.
			data-touch={isTouch ? "true" : undefined}
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
					// Only the record panel's pinned tile (its own discrete "this one
					// specifically" state, unrelated to scroll) — touch's own
					// "whichever tile is centred" look is driven by the ambient
					// scroll effect above instead, which explicitly skips any tile
					// with `data-active="true"` so the two don't fight over the
					// same `filter`/`scale` properties. `activeId` itself still
					// drives `NowShowing`'s content below — nothing about *that*
					// part needed the tile's own `data-active` at all, it was only
					// ever reusing the same field.
					active={record.id === focusedRecordId}
					onActivate={isTouch ? undefined : setActiveId}
					isTouch={isTouch}
					// `mountedIds == null` covers desktop and the touch path's
					// first render (before the loop's first measurement) — both
					// mount everything. `!isTouch` short-circuits so a stale set
					// from a previous touch stint can't hide content if the
					// device flips back to fine-pointer (a foldable, a mouse
					// plugging in).
					contentMounted={
						!isTouch || mountedIds == null || mountedIds.has(record.id)
					}
					onCoverReady={isTouch ? handleCoverReady : undefined}
				/>
			))}
			{/* Shared hover backdrop for every tile — see `.grid-focus-overlay` in
			    styles.css. `position: fixed` excludes it from the grid's own auto-
			    placement (an in-flow child here would otherwise consume a cell).
			    Masked to a radial gradient centred on the eased spotlight position
			    above (`--overlay-x/y`) so the blur opens up right where the
			    cursor/active tile is instead of snapping between "sharp tile" and
			    "blurred everything else" with nothing in between. Desktop-only —
			    touch has no equivalent. Several attempts at one (a shared
			    backdrop-filter overlay, then a per-tile filter: blur() driven by
			    scroll position) each hit real problems specific to touch/iOS —
			    see the `.grid-focus-overlay` comment in styles.css for the
			    history — so touch just doesn't get this affordance for now. */}
			{!isTouch && (
				<div
					ref={overlayRef}
					aria-hidden="true"
					className="grid-focus-overlay pointer-events-none fixed inset-0 bg-white/50 opacity-0 backdrop-blur-sm dark:bg-black/50"
				/>
			)}
			{lastActiveRecordRef.current && (
				<NowShowing
					record={lastActiveRecordRef.current}
					visible={activeRecord != null}
					isTouch={isTouch}
				/>
			)}
			{showPerf && <PerfMeter />}
		</div>
	);
}

/**
 * Dev instrumentation, mounted only with `?perf` in the URL: a fixed badge
 * showing, once a second, the worst main-thread frame gap and how many
 * frames blew a 34ms (two-vsync) budget in that second. Exists because none
 * of the usual tools can measure this where it matters — Chrome traces run
 * the wrong engine for iOS work, and WebDriver's automation banner blocks
 * real touch input on the Simulator — while this shows up legibly in a plain
 * screen recording of a real fling. One caveat when reading it: WebKit can
 * suppress rAF entirely during parts of a native momentum scroll, which
 * reports as one huge gap right as scrolling settles — that's the main
 * thread being *idle* while the compositor scrolls, not a hitch; the number
 * that matters is the worst frame while updates are actually flowing.
 */
function PerfMeter() {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let raf = 0;
		let last = performance.now();
		let windowStart = last;
		let worst = 0;
		let slow = 0;
		const tick = (now: number) => {
			const delta = now - last;
			last = now;
			if (delta > worst) worst = delta;
			if (delta > 34) slow++;
			if (now - windowStart > 1000) {
				if (ref.current) {
					ref.current.textContent = `worst ${Math.round(worst)}ms · >34ms ×${slow}`;
				}
				windowStart = now;
				worst = 0;
				slow = 0;
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);
	return (
		<div
			ref={ref}
			className="fixed top-14 left-2 z-50 rounded bg-black/80 px-2 py-1 font-mono text-[11px] text-white"
		/>
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
