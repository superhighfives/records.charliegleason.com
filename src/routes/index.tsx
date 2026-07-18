import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RecordPanel } from "#/components/record-panel";
import { SleevePlaceholder } from "#/components/sleeve-placeholder";
import { ThemeToggle } from "#/components/theme-toggle";
import { Input } from "#/components/ui/input";
import { Sheet, SheetContent } from "#/components/ui/sheet";
import { displayCoverKey, displayMatteKey } from "#/lib/cover";
import { emojiSrc } from "#/lib/emoji";
import { publicRecordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";

// charliegleason.com's emoji generator, rendering the 🎵 (musical note) glyph.
const HERO_EMOJI = emojiSrc("%F0%9F%8E%B5");

export const Route = createFileRoute("/")({
	// `?record=<id>` deep-links straight to a record's drawer, so a modal can be
	// shared or bookmarked and survives a reload / the back button.
	validateSearch: (
		search: globalThis.Record<string, unknown>,
	): { record?: number } => {
		const raw = search.record;
		const n =
			typeof raw === "number"
				? raw
				: typeof raw === "string"
					? Number(raw)
					: Number.NaN;
		return Number.isInteger(n) && n > 0 ? { record: n } : {};
	},
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
	component: Home,
});

function Home() {
	const { data } = useSuspenseQuery(publicRecordsQueryOptions);
	const navigate = Route.useNavigate();
	const { record: selectedId } = Route.useSearch();
	const [search, setSearch] = useState("");

	// The open record lives in the URL (`?record=<id>`). Paging replaces the entry
	// so arrow-keying through the collection doesn't flood the history stack;
	// opening/closing pushes so the back button steps in and out of a record.
	const openRecord = useCallback(
		(id: number | null, replace = false) =>
			navigate({
				search: (prev) => ({ ...prev, record: id ?? undefined }),
				replace,
				resetScroll: false,
			}),
		[navigate],
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

	// If the open record is filtered out (e.g. the search no longer matches it),
	// forget it entirely — clearing the id, not just deriving it away, so it can't
	// silently re-open when a later search brings the record back into view.
	useEffect(() => {
		if (selectedId != null && selectedIndex === -1) openRecord(null, true);
	}, [selectedId, selectedIndex, openRecord]);

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
				<ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4">
					{filtered.map((r) => (
						<li key={r.id} className="group cv-auto">
							<button
								type="button"
								onClick={() => openRecord(r.id)}
								className="w-full cursor-pointer space-y-2 text-left"
							>
								<div className="cover-lift">
									<div className="album-card grain aspect-square overflow-hidden">
										{(() => {
											// Prefer the floating matte (transparent, true edges) when the
											// record has one; its baked shadow + margin read as an object
											// on the card. Fall back to the square cover otherwise.
											const matte = displayMatteKey(r);
											const cover = matte ?? displayCoverKey(r);
											return cover ? (
												<img
													src={`/api/photos/${cover}`}
													alt={`${r.artist} — ${r.title}`}
													className={cn(
														"size-full grayscale transition-[filter] duration-500 ease-out group-hover:grayscale-0",
														matte ? "object-contain" : "object-cover",
													)}
													loading="lazy"
												/>
											) : (
												<SleevePlaceholder />
											);
										})()}
									</div>
								</div>
								<div className="text-sm leading-snug">
									<p
										className="truncate font-serif text-base font-medium"
										title={r.title ?? undefined}
									>
										{r.title}
									</p>
									<p className="truncate font-serif text-muted-foreground">
										{r.artist}
										{r.year ? ` · ${r.year}` : ""}
									</p>
									{r.pitchforkScore != null && (
										<p className="mt-1 text-xs font-bold text-brand-strong tabular-nums">
											{r.pitchforkScore}
											<span className="ml-1 font-normal opacity-0 transition-opacity duration-200 group-hover:opacity-100">
												on Pitchfork
											</span>
										</p>
									)}
								</div>
							</button>
						</li>
					))}
				</ul>
			)}

			<Sheet
				open={selected != null}
				onOpenChange={(open) => {
					// Replace, not push: opening pushed one entry, so closing collapses it
					// away rather than leaving a stale "back reopens the drawer" entry.
					if (!open) openRecord(null, true);
				}}
			>
				<SheetContent className="p-0">
					{shown && (
						<RecordPanel
							key={shown.record.id}
							record={shown.record}
							index={shown.index}
							total={filtered.length}
							onPrev={() => {
								const prev = filtered[shown.index - 1];
								if (prev) openRecord(prev.id, true);
							}}
							onNext={() => {
								const next = filtered[shown.index + 1];
								if (next) openRecord(next.id, true);
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
