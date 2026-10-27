import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CollectionGrid } from "#/components/collection-grid";
import { CollectionHero, heroDurationMs } from "#/components/collection-hero";
import { CollectionSkeleton } from "#/components/collection-skeleton";
import { CollectionStatsSentence } from "#/components/collection-stats-sentence";
import { useCollectionUI } from "#/components/collection-ui";
import { FilterStrip } from "#/components/filter-strip";
import { RecordPanel } from "#/components/record-panel";
import { ThemeToggle } from "#/components/theme-toggle";
import { Input } from "#/components/ui/input";
import { Sheet, SheetContent } from "#/components/ui/sheet";
import { WallGrid } from "#/components/wall/wall-grid";
import {
	type CollectionFilters,
	hasAnyFilter,
	matchesFilters,
	NO_FILTERS,
} from "#/lib/collection-filters";
import { emojiSrc } from "#/lib/emoji";
import { DEFAULT_FILTER_SETTINGS } from "#/lib/filter-settings";
import { recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";
import { filterSettingsQueryOptions } from "#/lib/settings-queries";

// charliegleason.com's emoji generator, rendering the 🎵 (musical note) glyph.
const HERO_EMOJI = emojiSrc("%F0%9F%8E%B5");

// Safety net for `useFontsReady` — a slow/failed font fetch (offline,
// blocked font CDN) shouldn't wedge the page behind the skeleton forever.
const FONT_READY_TIMEOUT_MS = 2000;

// Every Fraunces face the hero (and header `h1`) actually render with —
// weight + style, size doesn't matter for triggering the fetch. Keep this in
// sync with the `font-serif`/`italic`/`font-semibold` combinations used below.
const CRITICAL_FONTS = [
	"600 1em Fraunces",
	"500 1em Fraunces",
	"italic 500 1em Fraunces",
];

/**
 * True once every font in {@link CRITICAL_FONTS} has loaded, or after
 * {@link FONT_READY_TIMEOUT_MS}. Starts `false` on both server and client
 * (`document.fonts` doesn't exist during SSR) so hydration matches — the real
 * content only mounts once this flips, rather than painting text in a
 * fallback font that then reflows as each custom font swaps in.
 *
 * Explicitly `document.fonts.load(...)` each face rather than awaiting the
 * passive `document.fonts.ready` — `ready` only resolves once every font
 * *already in flight* has settled, and a font only enters flight once the
 * browser lays out text that needs it. The loading placeholder (`CollectionSkeleton`)
 * has no Fraunces text in it, so nothing on screen had actually requested Fraunces
 * yet: `ready` was resolving as a same-tick no-op, and the real fetch (and the
 * reflow it causes) only started once the hero text itself mounted — the
 * exact flash this hook exists to prevent. Explicit `load()` calls kick off
 * the request regardless of what's currently rendered.
 */
function useFontsReady(): boolean {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		if (typeof document === "undefined" || !("fonts" in document)) {
			setReady(true);
			return;
		}
		let cancelled = false;
		const timeout = setTimeout(() => {
			if (!cancelled) setReady(true);
		}, FONT_READY_TIMEOUT_MS);
		Promise.all(CRITICAL_FONTS.map((font) => document.fonts.load(font)))
			.catch(() => {})
			.finally(() => {
				if (!cancelled) setReady(true);
			});
		return () => {
			cancelled = true;
			clearTimeout(timeout);
		};
	}, []);
	return ready;
}

/**
 * Prototype switch for the 3D record wall (`WallGrid`) in place of the DOM
 * grid: `?wall` turns it on and `?wall=0` off, remembered in localStorage so
 * it survives opening records and reloads. Read in an effect, so SSR and the
 * first client render (the DOM grid) match.
 */
function useWallMode(): boolean {
	const [on, setOn] = useState(false);
	useEffect(() => {
		const param = new URLSearchParams(window.location.search).get("wall");
		try {
			if (param === "0") localStorage.removeItem("wall");
			else if (param != null) localStorage.setItem("wall", "1");
			setOn(localStorage.getItem("wall") === "1");
		} catch {
			setOn(param != null && param !== "0");
		}
	}, []);
	return on;
}

/**
 * The public collection: a grid of records with a record drawer overlaid on top.
 * The open record is driven by `selectedId`, which comes from the route — `null`
 * on `/`, the path id on `/records/<id>-<slug>`. Both routes render this one
 * component so the grid (and the text filter, held in context) survive opening
 * and closing a record.
 */
export function CollectionView({ selectedId }: { selectedId: number | null }) {
	const { data } = useSuspenseQuery(publicRecordsQueryOptions);
	// Prefetched by the layout's loader; the defaults only cover a failed fetch.
	const { data: filterSettings = DEFAULT_FILTER_SETTINGS } = useQuery(
		filterSettingsQueryOptions,
	);
	const navigate = useNavigate();
	const { search, setSearch, animateOpenRef } = useCollectionUI();
	const fontsReady = useFontsReady();
	const wallMode = useWallMode();

	// The open record lives in the URL path (`/records/<id>-<slug>`). Opening
	// pushes a history entry so the back button steps back out of a record;
	// paging + closing replace so arrow-keying through the collection (and the
	// close) don't flood the stack. Setting the animate flag before navigating
	// makes an in-app open slide in (a direct-nav open never runs this).
	const openRecord = useCallback(
		(
			r: { id: number; title: string | null } | null,
			{ replace = false }: { replace?: boolean } = {},
		) => {
			animateOpenRef.current = r != null;
			return r
				? navigate({
						to: "/records/$id",
						params: { id: recordIdParam(r) },
						replace,
						resetScroll: false,
					})
				: navigate({ to: "/", replace, resetScroll: false });
		},
		[navigate, animateOpenRef],
	);

	const [filters, setFilters] = useState<CollectionFilters>(NO_FILTERS);

	// Search first, then the filter strip — kept as two steps because the
	// strip's chip counts are scoped to the search matches (see `facetCounts`).
	const searched = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data;
		return data.filter((r) =>
			[r.artist, r.title, r.year]
				.filter(Boolean)
				.some((v) => String(v).toLowerCase().includes(q)),
		);
	}, [data, search]);

	const filtered = useMemo(
		() =>
			hasAnyFilter(filters)
				? searched.filter((r) => matchesFilters(r, filters))
				: searched,
		[searched, filters],
	);

	// Track the open record by id (not index) so re-filtering never jumps to the
	// wrong one.
	const selectedIndex =
		selectedId == null ? -1 : filtered.findIndex((r) => r.id === selectedId);
	const selected = selectedIndex >= 0 ? filtered[selectedIndex] : null;

	// Keep rendering the last-open record while the drawer slides shut. Radix keeps
	// the sheet mounted through its exit animation, but `selected` goes null the
	// instant we close — without this, the body would vanish before the slide-out.
	const lastShown = useRef<{
		record: (typeof filtered)[number];
		index: number;
	}>(null);
	if (selected) lastShown.current = { record: selected, index: selectedIndex };
	const shown = selected
		? { record: selected, index: selectedIndex }
		: lastShown.current;

	// If the open record is filtered out (e.g. the search no longer matches it) or
	// the id in the URL isn't a real record, drop back to the grid.
	useEffect(() => {
		if (selectedId != null && selectedIndex === -1)
			openRecord(null, { replace: true });
	}, [selectedId, selectedIndex, openRecord]);

	// Read the slide-in intent at the open edge only, so paging (which also sets
	// the flag, via `openRecord`, while `open` stays true throughout) doesn't
	// retrigger it. `wasOpenRef` tracks whether the *previous* commit was open,
	// so `enterAnimation` is true only on the actual closed→open transition —
	// unlike gating on `open` alone, this stays correct even though the flag
	// keeps getting set to `true` by paging in between.
	const open = selected != null;
	const wasOpenRef = useRef(false);
	const enterAnimation = open && !wasOpenRef.current && animateOpenRef.current;
	useEffect(() => {
		wasOpenRef.current = open;
		if (open) animateOpenRef.current = false;
	}, [open, animateOpenRef]);

	// Reuse the route's own loading skeleton as the font-loading gate too —
	// see `useFontsReady`. The data-loading and font-loading phases then read
	// as one continuous skeleton, and the real hero/grid only ever mounts (and
	// starts its own staged `rise-in`/`fade-in`, below) once every custom font
	// is actually ready to paint with, instead of racing it.
	if (!fontsReady) return <CollectionSkeleton />;

	// The statement writing itself in *is* the load (see `CollectionHero`);
	// everything else follows it in once it's done.
	const revealMs = heroDurationMs(data.length);

	return (
		<div className="w-full px-4 py-10 sm:px-6">
			{/* Staged reveal on first paint: hero copy, then the grid, then the
			    header chrome — see the `rise-in`/`fade-in` utilities in styles.css.
			    Each is a CSS `animation ... both`, so it only ever plays once per
			    mount (a search keystroke re-rendering this component doesn't
			    retrigger it) and holds `opacity: 0` for its own delay rather than
			    flashing in at full opacity before its turn. The grid wrapper uses
			    `fade-in` (opacity only), not `rise-in` (which also animates
			    `transform`) — see the comment on `.fade-in` for why a `transform`
			    on an ancestor of `CollectionGrid` would break its own fixed-position
			    children. Delays are inline `style`, not a Tailwind arbitrary
			    `[animation-delay:…]` class — `.rise-in`/`.fade-in` are plain
			    unlayered CSS (not `@layer utilities`), so they'd always beat a
			    layered Tailwind utility regardless of class order; inline style
			    always wins instead. */}
			{/* No header: the big statement is the page's opening. The home
			    link, search and the theme toggle live in one small floating pill in the corner instead, so
			    they're always within reach without a bar across the page.
			    Opaque rather than backdrop-blurred — it sits over the grid for
			    the whole scroll, and a blur under it would be recomposited every
			    scroll frame. */}
			<h1 className="sr-only">Records — Charlie Gleason's vinyl collection</h1>
			<div
				className="floating-controls rise-in"
				style={{ animationDelay: `${revealMs}ms` }}
			>
				<Link to="/" className="block shrink-0" title="Records">
					<img
						src={HERO_EMOJI}
						alt="Records home"
						width={28}
						height={28}
						className="size-7"
					/>
				</Link>
				<Input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search records…"
					aria-label="Search records"
					className="h-8 w-36 rounded-full border-0 bg-transparent shadow-none sm:w-56"
				/>
				<ThemeToggle className="size-8 rounded-full border-0" />
			</div>

			{/* `data-parallax` (wall mode only): see `WallGrid`. */}
			{!search.trim() && (
				<div
					data-parallax={wallMode ? -0.3 : undefined}
					data-parallax-fade={wallMode ? "" : undefined}
				>
					<CollectionHero count={data.length} />
				</div>
			)}

			<div className="rise-in" style={{ animationDelay: `${revealMs}ms` }}>
				<div>
					<FilterStrip
						records={data}
						countRecords={searched}
						filters={filters}
						settings={filterSettings}
						onChange={setFilters}
					/>
				</div>
			</div>

			<div
				className="fade-in min-h-[70vh]"
				style={{ animationDelay: `${revealMs + 150}ms` }}
				// `animation-fill-mode: both` (see `.fade-in`) never really "ends" —
				// it holds the finished keyframe indefinitely rather than the
				// animation being removed — which keeps Chrome compositing this
				// wrapper into its own layer forever. That layer boundary clips
				// what CollectionGrid's fixed, backdrop-blurred child
				// (`NowShowing`) can see behind it to just this
				// subtree, so the blur silently stops reaching sibling content
				// (e.g. the hero text above) once composited this way. Explicitly
				// canceling the animation once it visually completes releases the
				// layer and restores the correct backdrop-filter reach.
				onAnimationEnd={(e) => {
					e.currentTarget.style.animation = "none";
				}}
			>
				{data.length === 0 ? (
					<p className="text-muted-foreground">Nothing here yet.</p>
				) : filtered.length === 0 ? (
					<p className="text-muted-foreground">
						{search.trim()
							? `No records match “${search}”.`
							: "No records match those filters."}
					</p>
				) : wallMode ? (
					<WallGrid
						records={filtered}
						onOpen={openRecord}
						focusedRecordId={selected?.id ?? null}
					/>
				) : (
					<CollectionGrid
						records={filtered}
						onOpen={openRecord}
						focusedRecordId={selected?.id ?? null}
					/>
				)}
			</div>

			<Sheet
				open={open}
				onOpenChange={(next) => {
					// Replace, not push: opening pushed one entry, so closing collapses it
					// away rather than leaving a stale "back reopens the drawer" entry.
					if (!next) openRecord(null, { replace: true });
				}}
			>
				<SheetContent className="p-0" enterAnimation={enterAnimation}>
					{shown && (
						<RecordPanel
							key={shown.record.id}
							record={shown.record}
							index={shown.index}
							total={filtered.length}
							onPrev={() => {
								const prev = filtered[shown.index - 1];
								if (prev) openRecord(prev, { replace: true });
							}}
							onNext={() => {
								const next = filtered[shown.index + 1];
								if (next) openRecord(next, { replace: true });
							}}
						/>
					)}
				</SheetContent>
			</Sheet>

			<footer className="mt-16 border-t border-border pt-32 text-xs text-muted-foreground">
				<div
					data-parallax={wallMode ? -0.2 : undefined}
					data-parallax-fade={wallMode ? "" : undefined}
				>
					<CollectionStatsSentence records={data} />
				</div>
				<div
					className="mt-24 flex flex-wrap items-end justify-between gap-4"
					data-parallax={wallMode ? -0.08 : undefined}
				>
					<div>
						<p className="kicker-muted mb-2">The collection</p>A corner of{" "}
						<a
							href="https://charliegleason.com"
							className="text-brand-strong underline decoration-brand-strong/60 underline-offset-4 hover:text-foreground"
						>
							charliegleason.com
						</a>{" "}
						· set in Fraunces.
					</div>
					<button
						type="button"
						onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
						className="font-mono text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
					>
						Back to top ↑
					</button>
				</div>
			</footer>
		</div>
	);
}
