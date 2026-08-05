import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
	type CSSProperties,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { FadeImage, isImageDecoded } from "#/components/fade-image";
import { SleevePlaceholder } from "#/components/sleeve-placeholder";
import { Skeleton } from "#/components/ui/skeleton";
import { VinylDisc } from "#/components/vinyl-disc";
import { parseColorPalette } from "#/lib/color-palette";
import { DEFAULT_COLOR_NAME } from "#/lib/colors";
import { displayCoverKey, displayMatteKey, photoUrl } from "#/lib/cover";
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
	// Starts at the SSR default (4) on both server and client so the first
	// client paint matches the server-rendered markup; the real value (which
	// may differ on narrow viewports) is only read once mounted, in the effect
	// below.
	const [cols, setCols] = useState(4);
	useEffect(() => {
		const md = window.matchMedia("(min-width: 768px)");
		const sm = window.matchMedia("(min-width: 640px)");
		const update = () => setCols(readColumns());
		update();
		md.addEventListener("change", update);
		sm.addEventListener("change", update);
		return () => {
			md.removeEventListener("change", update);
			sm.removeEventListener("change", update);
		};
	}, []);
	return cols;
}

/**
 * False during SSR and the first client paint, true after mount. This is one of
 * the few legitimate uses of `setState` in an effect — the virtualizer needs
 * `window`, so the very first client render must still match the server's (no
 * `window`) to avoid a hydration mismatch, and only the *next* render can switch
 * on. That switch swaps `CollectionGrid` from the plain map below to the
 * virtualized tree, which unmounts and remounts every `RecordTile` (they're
 * structurally different subtrees, so React can't reconcile across them) —
 * `FadeImage`'s reveal is deliberately resilient to that (see its `reveal`
 * rAF-guard comment), but any *other* per-tile state or side effect added later
 * should assume it gets reset the instant the page becomes interactive.
 */
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
 * One cover tile: the peeking vinyl disc behind the cover, plus the
 * title/artist/score. `.group` drives the hover states (grayscale→colour, the
 * disc slide-out, and the title "branding" itself with the record's own vinyl
 * colour — see the palette gradient below). The disc deliberately overflows the
 * tile sideways, so nothing wrapping a tile may clip overflow.
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
	// A grid tile never renders wider than ~250px (4 columns in the max-w-5xl
	// container) — 500 covers that at 2x without shipping the ~1MB master.
	const coverSrc = cover ? photoUrl(cover, 500) : undefined;
	// Keep the peeking vinyl disc faint (10%) until the cover is up, then fade it to
	// full in step with the cover — so a slow/lazy tile never flashes a bold disc
	// behind a not-yet-loaded (now background-less) cover. No cover at all → the
	// placeholder is there immediately, so the disc shows straight away. Seeded from
	// `FadeImage`'s own decoded-src cache too, so a cover the grid has already shown
	// this session (e.g. scrolling back to a row outside the overscan window) mounts
	// the disc at full opacity instead of replaying the fade the cover itself skips.
	const [coverReady, setCoverReady] = useState(
		() => !cover || isImageDecoded(coverSrc),
	);
	// On hover the title "brands" itself with the record's own vinyl colour (it
	// replaced the old yellow cover-lift bar). Rather than clip the photographic
	// texture into the glyphs — which split a wide title across the texture's own
	// dark→light sweep and routinely went half-invisible — we clip a controlled
	// two-stop gradient built from the chip's extracted palette (see
	// color-palette.ts), with lightness clamped per theme in CSS (`.title-palette`)
	// so it always reads. Records whose chip has no palette yet keep the default
	// (untinted) title on hover, same as the peeking disc's plain-colour fallback.
	// The default (Black) chip brands its title in the site accent on hover rather
	// than a near-black palette gradient that barely reads — see the brand fallback
	// below. Every other chip uses its own extracted palette when it has one.
	const isDefaultColor = record.colorName === DEFAULT_COLOR_NAME;
	const palette = isDefaultColor
		? null
		: parseColorPalette(record.colorPalette);
	const paletteFrom = palette?.colors[0];
	const paletteTo = palette?.colors[1] ?? palette?.colors[0];
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
						translucent={record.colorTranslucent}
						size={record.size}
						discCount={record.discCount}
						className={cn(
							"transition-opacity duration-700 ease-out motion-reduce:transition-none delay-700",
							coverReady ? "opacity-100" : "opacity-0",
						)}
					/>
					<div className="relative aspect-square overflow-hidden">
						{/* Shown behind the cover while it loads — `-z-10` (rather than
						    unmounting once ready) so it never has to fight FadeImage's own
						    opacity for stacking order; the opaque cover simply paints over
						    it once revealed. Cover-less tiles skip straight to the
						    placeholder, so no skeleton for those. */}
						{cover && !coverReady && (
							<Skeleton className="absolute inset-0 -z-10 rounded-none" />
						)}
						{cover ? (
							<FadeImage
								src={coverSrc}
								alt={`${record.artist} — ${record.title}`}
								onReady={() => setCoverReady(true)}
								className={cn(
									// Fade in on load *and* keep the grayscale→colour hover —
									// one combined transition property so both animate. Opacity
									// itself stays driven by FadeImage's own `loaded` state (via
									// onReady below just for the disc) — mirroring it here too
									// would round-trip through a second component's state update,
									// which can resolve before the browser ever paints the hidden
									// frame, skipping the fade entirely.
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
				<div className="text-sm leading-snug">
					<p
						className={cn(
							"truncate font-serif text-base font-medium transition-colors duration-300 ease-out",
							paletteFrom
								? "title-palette bg-clip-text group-hover:text-transparent"
								: // Black default: brand the title in the site accent on hover.
									isDefaultColor && "group-hover:text-brand-strong",
						)}
						style={
							paletteFrom
								? ({
										"--pal-a": paletteFrom,
										"--pal-b": paletteTo,
									} as CSSProperties)
								: undefined
						}
						title={record.title ?? undefined}
					>
						{record.title}
					</p>
					<p className="truncate font-serif text-muted-foreground">
						{record.artist}
						{record.year ? ` · ${record.year}` : ""}
					</p>
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
