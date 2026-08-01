import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { CollectionGrid } from "#/components/collection-grid";
import { useCollectionUI } from "#/components/collection-ui";
import { RecordPanel } from "#/components/record-panel";
import { ThemeToggle } from "#/components/theme-toggle";
import { Input } from "#/components/ui/input";
import { Sheet, SheetContent } from "#/components/ui/sheet";
import { emojiSrc } from "#/lib/emoji";
import { recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

// charliegleason.com's emoji generator, rendering the 🎵 (musical note) glyph.
const HERO_EMOJI = emojiSrc("%F0%9F%8E%B5");

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

	// Read the slide-in intent at the open edge and consume it once open, so paging
	// and unrelated re-renders don't retrigger it. Radix only runs the enter
	// transition on the closed→open edge, so a render-phase read is sufficient.
	const open = selected != null;
	const enterAnimation = open && animateOpenRef.current;
	useEffect(() => {
		if (open) animateOpenRef.current = false;
	}, [open, animateOpenRef]);

	return (
		<div className="w-full mx-auto max-w-5xl px-4 py-10 sm:px-6">
			<header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
				<div className="flex items-center gap-4">
					<a href="https://charliegleason.com" className="block shrink-0">
						<img
							src={HERO_EMOJI}
							alt=""
							aria-hidden="true"
							width={56}
							height={56}
							className="size-14"
						/>
						<span className="sr-only">charliegleason.com</span>
					</a>
					<div>
						<p className="kicker mb-1">The collection</p>
						<h1 className="font-serif text-4xl font-semibold tracking-tight">
							Records
						</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							<span className="font-medium text-foreground tabular-nums">
								{data.length}
							</span>{" "}
							records ·{" "}
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

			{data.length === 0 ? (
				<p className="text-muted-foreground">Nothing here yet.</p>
			) : filtered.length === 0 ? (
				<p className="text-muted-foreground">No records match “{search}”.</p>
			) : (
				<CollectionGrid records={filtered} onOpen={openRecord} />
			)}

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

			<footer className="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
				A corner of{" "}
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
