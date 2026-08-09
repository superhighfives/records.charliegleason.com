import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CollectionGrid } from "#/components/collection-grid";
import { CollectionSkeleton } from "#/components/collection-skeleton";
import { useCollectionUI } from "#/components/collection-ui";
import { RecordPanel } from "#/components/record-panel";
import { ThemeToggle } from "#/components/theme-toggle";
import { Input } from "#/components/ui/input";
import { Sheet, SheetContent } from "#/components/ui/sheet";
import { emojiSrc } from "#/lib/emoji";
import { numberToWords } from "#/lib/number-to-words";
import { recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

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
 * browser lays out text that needs it. The loading skeleton (`CollectionSkeleton`)
 * is a spinner, not text, so nothing on screen had actually requested Fraunces
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
 * The public collection: a grid of records with a record drawer overlaid on top.
 * The open record is driven by `selectedId`, which comes from the route — `null`
 * on `/`, the path id on `/records/<id>-<slug>`. Both routes render this one
 * component so the grid (and the text filter, held in context) survive opening
 * and closing a record.
 */
export function CollectionView({ selectedId }: { selectedId: number | null }) {
	const { data } = useSuspenseQuery(publicRecordsQueryOptions);
	const navigate = useNavigate();
	const { search, setSearch, animateOpenRef } = useCollectionUI();
	const fontsReady = useFontsReady();

	// Whether the open drawer should slide in. True only when this open was an
	// in-app action — `openRecord` sets the flag before navigating; a direct-nav /
	// SSR open leaves it false so the drawer appears in place. This view no longer
	// remounts on open (the `_collection` layout keeps it mounted), so the intent
	// is read at the open edge rather than captured per mount.

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

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data;
		return data.filter((r) =>
			[r.artist, r.title, r.year]
				.filter(Boolean)
				.some((v) => String(v).toLowerCase().includes(q)),
		);
	}, [data, search]);

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
	// as one continuous skeleton, and the real header/hero/grid only ever
	// mounts (and starts its own staged `rise-in`/`fade-in`, below) once every
	// custom font is actually ready to paint with, instead of racing it.
	if (!fontsReady) return <CollectionSkeleton />;

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
			<header
				className="rise-in mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between"
				style={{ animationDelay: "500ms" }}
			>
				<div className="flex items-center gap-4">
					<a href="https://charliegleason.com" className="block shrink-0">
						<img
							src={HERO_EMOJI}
							alt=""
							aria-hidden="true"
							width={64}
							height={64}
							className="size-16"
						/>
						<span className="sr-only">charliegleason.com</span>
					</a>
					<div>
						<h1 className="font-serif text-4xl font-semibold tracking-tight">
							Records
						</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							<span className="font-medium text-foreground tabular-nums">
								{data.length}
							</span>{" "}
							vinyls ·{" "}
							<a
								href="https://charliegleason.com"
								className="text-brand-strong underline decoration-brand-strong/60 underline-offset-4 hover:text-foreground"
							>
								charliegleason.com
							</a>
						</p>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<Input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search records…"
						className="w-full sm:w-64"
					/>
					<ThemeToggle />
				</div>
			</header>

			{!search.trim() && (
				<div className="min-h-[70vh] flex items-center">
					<p className="rise-in my-16 max-w-6xl font-serif text-5xl font-medium tracking-tight text-pretty sm:text-6xl lg:text-8xl">
						<span className="text-brand italic">All</span>{" "}
						<span className="px-[0.1ch]">{numberToWords(data.length)}</span>{" "}
						<span className="text-brand italic">
							of my records, photographed, documented, and displayed.
						</span>
					</p>
				</div>
			)}

			<div className="fade-in min-h-[70vh]" style={{ animationDelay: "250ms" }}>
				{data.length === 0 ? (
					<p className="text-muted-foreground">Nothing here yet.</p>
				) : filtered.length === 0 ? (
					<p className="text-muted-foreground">No records match “{search}”.</p>
				) : (
					<CollectionGrid
						records={filtered}
						onOpen={openRecord}
						focusedRecordId={shown?.record.id ?? null}
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

			<footer className="mt-16 border-t border-border pt-48 text-xs text-muted-foreground">
				<p className="my-16 max-w-6xl font-serif text-4xl font-medium tracking-tight text-pretty sm:text-5xl lg:text-7xl text-muted-foreground italic">
					Well, that was all {data.length} of my records, photographed,
					documented, and displayed.
				</p>
				<p className="kicker-muted mb-2">The collection</p>A corner of{" "}
				<a
					href="https://charliegleason.com"
					className="text-brand-strong underline decoration-brand-strong/60 underline-offset-4 hover:text-foreground"
				>
					charliegleason.com
				</a>{" "}
				· set in Fraunces.
			</footer>
		</div>
	);
}
