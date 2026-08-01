import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";

import { FadeImage } from "#/components/fade-image";
import { SleevePlaceholder } from "#/components/sleeve-placeholder";
import { VinylDisc } from "#/components/vinyl-disc";
import { displayCoverKey, displayMatteKey } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";
import { cn } from "#/lib/utils";

// Tailwind `gap-5` (1.25rem / 20px) — the grid's column *and* row gap.
const GAP_REM = 1.25;

/** Column count matching the CSS grid: 2 (<640px), 3 (<768px), 4 (≥768px). */
function readColumns(): number {
	if (typeof window === "undefined") return 4;
	if (window.matchMedia("(min-width: 768px)").matches) return 4;
	if (window.matchMedia("(min-width: 640px)").matches) return 3;
	return 2;
}

function useColumns(): number {
	const [cols, setCols] = useState(readColumns);
	useEffect(() => {
		const md = window.matchMedia("(min-width: 768px)");
		const sm = window.matchMedia("(min-width: 640px)");
		const update = () => setCols(readColumns());
		md.addEventListener("change", update);
		sm.addEventListener("change", update);
		update();
		return () => {
			md.removeEventListener("change", update);
			sm.removeEventListener("change", update);
		};
	}, []);
	return cols;
}

/** False during SSR and the first client paint, true after mount. */
function useMounted(): boolean {
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	return mounted;
}

function chunk<T>(items: T[], size: number): T[][] {
	if (size < 1) return [items];
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		rows.push(items.slice(i, i + size));
	return rows;
}

/**
 * One cover tile: the peeking vinyl disc behind a lift-on-hover cover, plus the
 * title/artist/score. `.group` drives the hover states (grayscale→colour, the
 * disc slide-out, the lift). The disc deliberately overflows the tile sideways,
 * so nothing wrapping a tile may clip overflow.
 */
function RecordTile({
	record,
	onOpen,
}: {
	record: PublicRecord;
	onOpen: (record: PublicRecord) => void;
}) {
	const matte = displayMatteKey(record);
	const cover = matte ?? displayCoverKey(record);
	return (
		<div className="group">
			<button
				type="button"
				onClick={() => onOpen(record)}
				className="w-full cursor-pointer space-y-2 text-left"
			>
				<div className="relative">
					<VinylDisc
						colorName={record.colorName}
						textureImageKey={record.colorTextureImageKey}
						textureStatus={record.colorTextureStatus}
						size={record.size}
						discCount={record.discCount}
					/>
					<div className="cover-lift">
						<div className="album-card grain aspect-square overflow-hidden">
							{cover ? (
								<FadeImage
									src={`/api/photos/${cover}`}
									alt={`${record.artist} — ${record.title}`}
									className={cn(
										// Fade in on load *and* keep the grayscale→colour hover —
										// one combined transition property so both animate.
										"size-full grayscale transition-[opacity,filter] duration-500 ease-out group-hover:grayscale-0",
										matte ? "object-contain" : "object-cover",
									)}
									loading="lazy"
								/>
							) : (
								<SleevePlaceholder />
							)}
						</div>
					</div>
				</div>
				<div className="text-sm leading-snug">
					<p
						className="truncate font-serif text-base font-medium"
						title={record.title ?? undefined}
					>
						{record.title}
					</p>
					<p className="truncate font-serif text-muted-foreground">
						{record.artist}
						{record.year ? ` · ${record.year}` : ""}
					</p>
					{record.pitchforkScore != null && (
						<p className="mt-1 text-xs font-bold text-brand-strong tabular-nums">
							{record.pitchforkScore}
							<span className="ml-1 font-normal opacity-0 transition-opacity duration-200 group-hover:opacity-100">
								on Pitchfork
							</span>
						</p>
					)}
				</div>
			</button>
		</div>
	);
}

/**
 * The record grid, row-virtualized against the window scroll. Only the rows near
 * the viewport are in the DOM; `measureElement` reads each row's true height so
 * variable tiles (some carry a Pitchfork line) and the square covers — whose size
 * tracks the column width — stay correctly spaced across breakpoints.
 *
 * Virtualization is client-only (`useMounted`): SSR and the first client paint
 * render the plain grid, so hydration matches and there's no window/measurement
 * on the server. Row wrappers never set `overflow`, so the vinyl disc's sideways
 * peek isn't clipped.
 */
export function CollectionGrid({
	records,
	onOpen,
}: {
	records: PublicRecord[];
	onOpen: (record: PublicRecord) => void;
}) {
	const columns = useColumns();
	const mounted = useMounted();
	const rows = useMemo(() => chunk(records, columns), [records, columns]);

	// Distance from the document top to the grid — the window virtualizer needs it
	// to map window scroll onto row offsets (everything above the grid is the
	// header). Re-measured on resize (header height changes with layout).
	const listRef = useRef<HTMLDivElement>(null);
	const [scrollMargin, setScrollMargin] = useState(0);
	useEffect(() => {
		const measure = () => {
			const el = listRef.current;
			if (el) setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);

	const virtualizer = useWindowVirtualizer({
		count: rows.length,
		// Rough first guess; `measureElement` corrects each row once it mounts.
		estimateSize: () => 340,
		overscan: 3,
		scrollMargin,
		getItemKey: (index) => rows[index]?.[0]?.id ?? index,
	});

	const gridStyle: React.CSSProperties = {
		display: "grid",
		gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
		gap: `${GAP_REM}rem`,
	};

	if (!mounted) {
		return (
			<div style={gridStyle}>
				{records.map((record) => (
					<RecordTile key={record.id} record={record} onOpen={onOpen} />
				))}
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			style={{ position: "relative", height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map((virtualRow) => (
				<div
					key={virtualRow.key}
					data-index={virtualRow.index}
					ref={virtualizer.measureElement}
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
						// gap-5 handles the column gaps within a row; separate per-row grids
						// don't share the parent's row-gap, so reserve it below each row
						// (measureElement includes padding in the height it reads).
						paddingBottom: `${GAP_REM}rem`,
					}}
				>
					<div style={gridStyle}>
						{rows[virtualRow.index].map((record) => (
							<RecordTile key={record.id} record={record} onOpen={onOpen} />
						))}
					</div>
				</div>
			))}
		</div>
	);
}
