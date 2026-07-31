import { SignedIn } from "@clerk/clerk-react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { Link } from "@tanstack/react-router";
import {
	BadgeCheck,
	Check,
	ChevronLeft,
	ChevronRight,
	Copy,
	ExternalLink,
	Link2,
	SquarePen,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { FadeImage } from "#/components/fade-image";
import { NotesContent } from "#/components/notes-content";
import { SleevePlaceholder } from "#/components/sleeve-placeholder";
import { Button } from "#/components/ui/button";
import { ImageZoom } from "#/components/ui/image-zoom";
import {
	SheetDescription,
	SheetFooter,
	SheetTitle,
} from "#/components/ui/sheet";
import type { Record } from "#/db/schema";
import { displayCoverKey, displayMatteKey } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";
import { recordPath } from "#/lib/records-path";
import { cn } from "#/lib/utils";
import { effectiveValue, formatMoney, parseValueBreakdown } from "#/lib/value";

/**
 * What the panel renders. Public callers pass a {@link PublicRecord} (no
 * capture photo, no valuation); the admin drawer passes a full row and sets
 * `admin` to surface the private valuation fields, which are optional here so
 * both shapes fit.
 */
export type PanelRecord = Omit<PublicRecord, "copies"> &
	// `copies` (physical copies owned) is derived on the public list; the admin drawer
	// passes a raw row without it, so it's optional here — the "Copies" line only shows
	// when it's ≥ 2 anyway.
	Partial<Pick<PublicRecord, "copies">> &
	Partial<
		Pick<
			Record,
			| "manualValue"
			| "discogsValue"
			| "discogsValueCurrency"
			| "discogsValueJson"
			| "discogsValueFetchedAt"
		>
	>;

/** A headline fact rendered as a bordered card (the OpenRouter-style stat grid). */
function Stat({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="border border-border p-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-0.5 font-medium tabular-nums">{children ?? "—"}</p>
		</div>
	);
}

/** A label/value line in the Specifications list. */
function Spec({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-2 text-sm">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-right">{children ?? "—"}</dd>
		</div>
	);
}

function dash(value: string | number | null | undefined): ReactNode {
	if (value == null || value === "") return "—";
	return value;
}

/**
 * Admin-only valuation block: the headline value (confirmed manual figure if the
 * collector entered one, else the Discogs guess), both underlying numbers, and
 * the per-condition Discogs breakdown when we have it.
 */
function AdminValuation({ record }: { record: PanelRecord }) {
	const currency = record.discogsValueCurrency ?? "USD";
	const effective = effectiveValue(record);
	const confirmed = record.manualValue != null;
	const breakdown = parseValueBreakdown(record.discogsValueJson);

	if (effective == null && record.discogsValue == null) {
		return (
			<div>
				<h3 className="mb-1 text-sm font-semibold">Valuation</h3>
				<p className="text-sm text-muted-foreground">
					No value yet — fetch it from Discogs or enter one manually on the
					record page.
				</p>
			</div>
		);
	}

	return (
		<div>
			<h3 className="mb-1 text-sm font-semibold">Valuation</h3>
			<p className="text-2xl font-semibold tabular-nums">
				{formatMoney(effective, currency)}
				<span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
					{confirmed ? "confirmed" : "estimated"}
				</span>
			</p>
			<dl className="mt-2 divide-y divide-border">
				<Spec label="Manual value">
					{record.manualValue != null
						? formatMoney(record.manualValue, currency)
						: "—"}
				</Spec>
				<Spec label="Discogs guess">
					{record.discogsValue != null
						? formatMoney(record.discogsValue, currency)
						: "—"}
				</Spec>
			</dl>
			{breakdown.length > 0 && (
				<div className="mt-2 rounded-md border border-border p-2">
					<p className="mb-1 text-xs text-muted-foreground">
						Discogs price by condition
					</p>
					<ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
						{breakdown.map(({ grade, price }) => (
							<li key={grade} className="flex justify-between gap-2">
								<span className="truncate text-muted-foreground">{grade}</span>
								<span className="tabular-nums">
									{formatMoney(price, currency)}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/**
 * The panel's header artwork: the floating matte (transparent, true-edged sleeve
 * with a baked shadow) when the record has one, falling back to the square cover
 * and then a placeholder. Tapping it opens a lightbox of the full cover.
 * Positioning is supplied by the caller via `className` so it can overhang the
 * header edge.
 */
function CoverZoom({
	coverSrc,
	matteSrc,
	className,
	onOpenChange,
}: {
	coverSrc: string | null;
	matteSrc: string | null;
	className?: string;
	/**
	 * Notified when the lightbox opens/closes so the panel can gate its arrow-key
	 * pager — otherwise an arrow press while the lightbox is open pages to another
	 * record (which remounts the panel) instead of doing nothing.
	 */
	onOpenChange?: (open: boolean) => void;
}) {
	// Matte preferred as the thumbnail; the cover is what the lightbox blows up.
	const thumbSrc = matteSrc ?? coverSrc;
	if (!thumbSrc) {
		return (
			<div className={className}>
				<SleevePlaceholder />
			</div>
		);
	}
	return (
		<ImageZoom
			src={coverSrc ?? thumbSrc}
			alt="cover"
			className={className}
			onOpenChange={onOpenChange}
		>
			<img
				src={thumbSrc}
				alt=""
				className={cn(
					"size-full rotate-3",
					matteSrc
						? "object-contain drop-shadow-xl"
						: "rounded-sm object-cover shadow-lg",
				)}
			/>
		</ImageZoom>
	);
}

/**
 * The record detail drawer body — a title header with the cover floating at its
 * right edge, a grid of headline facts, a specifications list, notes, and
 * prev/next paging through the current (filtered) collection. Rendered inside a
 * `<SheetContent>`.
 */
export function RecordPanel({
	record,
	index,
	total,
	onPrev,
	onNext,
	admin = false,
}: {
	record: PanelRecord;
	index: number;
	total: number;
	onPrev: () => void;
	onNext: () => void;
	/** Admin drawer: surface the private valuation + pinned-release status. */
	admin?: boolean;
}) {
	// Which value was last copied, so the right button shows its confirmation tick.
	// Resets on its own; the panel is keyed by record id at the call site, so paging
	// to another record remounts this component with a fresh state.
	const [copied, setCopied] = useState<"catno" | "link" | null>(null);

	// The cover lightbox opens its own dialog on top of the panel. While it's open
	// the arrow-key pager must stand down — otherwise an arrow press pages to
	// another record (remounting the panel) instead of being handled by the dialog.
	const [zoomOpen, setZoomOpen] = useState(false);

	const copy = async (
		text: string | null | undefined,
		key: "catno" | "link",
	) => {
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			setCopied(key);
		} catch {
			// Clipboard denied (insecure context / permissions) — nothing to do.
		}
	};

	// A shareable, absolute deep link to this record's page (the canonical
	// `/records/<id>-<slug>` path). Built at click time so it works off any host.
	const copyLink = () =>
		copy(`${window.location.origin}${recordPath(record)}`, "link");

	// Prefer the specific release when we have one, otherwise fall back to the
	// master (the album as a work). Public records always carry a master, so there
	// is normally a target either way.
	const discogsId = record.discogsId ?? record.masterId;
	const discogsHref = record.discogsId
		? (record.discogsUrl ??
			`https://www.discogs.com/release/${record.discogsId}`)
		: record.masterId
			? `https://www.discogs.com/master/${record.masterId}`
			: (record.discogsUrl ?? null);

	// Clear the "copied" tick after a moment. Driven by an effect so the timer is
	// cancelled on unmount (paging remounts the panel), avoiding a state update on
	// an unmounted component.
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(null), 1500);
		return () => clearTimeout(t);
	}, [copied]);

	// Admin drawer falls back to the raw capture so an in-progress record still
	// shows an image; the public panel shows only an approved photo (else nothing).
	const cover = displayCoverKey(record, { includeCapture: admin });
	// The floating matte (only present on approved photos) is the header thumbnail.
	const matte = displayMatteKey(record);

	const added = record.createdAt
		? record.createdAt.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			})
		: null;

	// Arrow keys page through the collection (Escape is handled by the Sheet).
	// useHotkeys matches the *bare* arrows only, so modified combos — notably
	// Cmd/Alt+Arrow for browser back/forward — pass straight through instead of
	// being hijacked. `ignoreInputs` (on by default for single keys) also skips
	// events from text fields, so caret movement in the notes editor is safe.
	useHotkeys(
		[
			{ hotkey: "ArrowLeft", callback: onPrev },
			{ hotkey: "ArrowRight", callback: onNext },
		],
		{ enabled: !zoomOpen },
	);

	// The header is a square cover hero with the title copy pinned to its bottom
	// edge. It sticks with a negative `top` so the empty top of the square scrolls
	// away and only the bottom band — the title and matte — stays fixed. That offset
	// is (title height − hero height); both depend on layout (panel width, title
	// length), so it's measured here and kept current with a ResizeObserver rather
	// than hard-coded.
	const scrollRef = useRef<HTMLDivElement>(null);
	const headerRef = useRef<HTMLDivElement>(null);
	const barRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = scrollRef.current;
		const header = headerRef.current;
		const bar = barRef.current;
		if (!el || !header || !bar) return;
		// Distance the header travels before it pins (the empty top of the square).
		let collapse = 1;
		let raf = 0;
		// `--hero` runs 0 (at the top) → 1 (once pinned); the backdrop reads it to
		// fade out as the hero collapses, so the pinned band is just the title and
		// matte. Written straight onto the node, so scrolling never re-renders.
		const paint = () => {
			raf = 0;
			el.style.setProperty(
				"--hero",
				String(Math.min(1, Math.max(0, el.scrollTop / collapse))),
			);
		};
		const measure = () => {
			// Clamp to ≤ 0: if the title band is taller than the square (a long title
			// in the narrow column left by the cover gutter on a full-width sheet), a
			// positive `top` would push the header *down* instead of pinning it — there
			// is simply no empty top to collapse, so it sticks flush at 0.
			const top = Math.min(
				0,
				Math.round(bar.offsetHeight - header.offsetHeight),
			);
			header.style.top = `${top}px`;
			collapse = Math.max(1, -top);
			paint();
		};
		const onScroll = () => {
			if (!raf) raf = requestAnimationFrame(paint);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		ro.observe(bar);
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			ro.disconnect();
			el.removeEventListener("scroll", onScroll);
			if (raf) cancelAnimationFrame(raf);
		};
	}, []);

	return (
		<>
			{/* Admin-only jump to the full editor. Clerk's `SignedIn` renders nothing
			    for signed-out visitors, so this never shows on the public site. `pr-12`
			    keeps the row clear of the Sheet's top-right close button. */}
			<SignedIn>
				<div className="flex items-center gap-2 border-b border-border bg-brand/5 px-6 py-4 pr-12">
					<span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-brand-strong">
						Admin
					</span>
					<Link
						to="/admin/records/$id"
						params={{ id: String(record.id) }}
						className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-strong hover:text-foreground"
					>
						<SquarePen className="size-3.5" />
						Edit record
					</Link>
				</div>
			</SignedIn>
			{/* The panel scrolls in one column. The header is a square cover hero: the
			    cover (never the matte) heavily faded as a backdrop, the title copy at
			    its bottom edge, and the matte floating over that edge. It sticks with a
			    negative `top` (set in the effect above) so the empty top scrolls away
			    and only the bottom band — title and matte — stays pinned while the
			    specs and notes scroll beneath. `bg-background` hides that content
			    behind the band, and the backdrop fades out via `--hero` as it
			    collapses, leaving just the title and matte once pinned. */}
			<div ref={scrollRef} className="relative flex-1 overflow-y-auto">
				<div
					ref={headerRef}
					className="sticky z-10 flex aspect-square flex-col justify-end bg-background"
				>
					{cover && (
						<div
							aria-hidden
							className="pointer-events-none absolute inset-0 -z-10"
							style={{ opacity: "calc(1 - var(--hero, 0))" }}
						>
							<FadeImage
								src={`/api/photos/${cover}`}
								alt=""
								className="size-full object-cover opacity-10"
							/>
						</div>
					)}
					<div
						ref={barRef}
						className="relative min-w-0 p-6 pr-52 before:content-[''] before:h-px before:w-full before:absolute before:bottom-0 before:left-0 before:bg-muted before:opacity-[calc(var(--hero,0))]"
					>
						<SheetTitle className="min-w-0 font-serif text-lg leading-tight text-pretty">
							{record.title}{" "}
							<button
								type="button"
								onClick={copyLink}
								aria-label="Copy link to this record"
								className="ml-0.5 inline-flex -translate-y-px items-center align-middle text-muted-foreground transition-colors hover:text-foreground"
							>
								{copied === "link" ? (
									<Check className="size-3.5" />
								) : (
									<Link2 className="size-3.5" />
								)}
							</button>
						</SheetTitle>
						<SheetDescription className="font-serif text-pretty">
							{record.artist}
							{record.year ? ` · ${record.year}` : ""}
						</SheetDescription>
						{admin && record.discogsId && (
							<span className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-xs font-medium text-brand-strong">
								<BadgeCheck className="size-3.5" />
								Release pinned
							</span>
						)}
						{(discogsHref || record.catno) && (
							<div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
								{discogsHref && (
									<div className="space-y-0.5">
										<p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
											Discogs
										</p>
										<a
											href={discogsHref}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums hover:text-brand"
										>
											{discogsId ? `#${discogsId}` : "View on Discogs"}
											<ExternalLink className="size-3 text-muted-foreground" />
										</a>
									</div>
								)}
								{record.catno && (
									<div className="space-y-0.5">
										<p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
											Catalog
										</p>
										<button
											type="button"
											onClick={() => copy(record.catno, "catno")}
											className="inline-flex items-center gap-1.5 text-sm font-medium hover:text-brand"
										>
											{record.catno}
											{copied === "catno" ? (
												<Check className="size-3" />
											) : (
												<Copy className="size-3 text-muted-foreground" />
											)}
										</button>
									</div>
								)}
							</div>
						)}
					</div>
					<CoverZoom
						coverSrc={cover ? `/api/photos/${cover}` : null}
						matteSrc={matte ? `/api/photos/${matte}` : null}
						onOpenChange={setZoomOpen}
						className="absolute right-8 -bottom-8 z-10 aspect-square w-44"
					/>
				</div>

				{record.notes && (
					<div className="p-2 border-b">
						<div className="relative overflow-hidden rounded-lg border border-brand/50 bg-gradient-to-br from-brand/10 via-brand/[0.04] to-transparent p-4">
							<h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wide text-brand-strong">
								Notes
							</h3>
							<NotesContent className="font-mono text-sm leading-relaxed text-pretty text-foreground/90">
								{record.notes}
							</NotesContent>
						</div>
					</div>
				)}

				<div className="p-6 space-y-6">
					<div className="grid grid-cols-3 gap-2">
						<Stat label="Year">{dash(record.year)}</Stat>
						<Stat label="Format">{dash(record.format)}</Stat>
						<Stat label="Size">{dash(record.size)}</Stat>
					</div>

					<div>
						<dl className="divide-y divide-border">
							<Spec label="Genre">{dash(record.genre)}</Spec>
							<Spec label="Country">{dash(record.country)}</Spec>
							<Spec label="Label">{dash(record.label)}</Spec>
							<Spec label="Added">{dash(added)}</Spec>
							{record.copies != null && record.copies > 1 && (
								<Spec label="Copies">{record.copies} copies</Spec>
							)}
							{record.pitchforkScore != null && (
								<Spec label="Pitchfork">
									{record.pitchforkUrl ? (
										<a
											href={record.pitchforkUrl}
											target="_blank"
											rel="noreferrer"
											className="font-semibold tabular-nums text-brand hover:text-brand-strong"
										>
											{record.pitchforkScore}
										</a>
									) : (
										<span className="font-semibold tabular-nums text-brand">
											{record.pitchforkScore}
										</span>
									)}
								</Spec>
							)}
						</dl>
					</div>

					{admin && <AdminValuation record={record} />}
				</div>
			</div>

			<SheetFooter className="justify-between border-t border-border">
				<span className="text-sm text-muted-foreground tabular-nums">
					{index + 1} / {total}
				</span>
				<div className="flex gap-2">
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						disabled={index <= 0}
						onClick={onPrev}
						aria-label="Previous record"
					>
						<ChevronLeft />
					</Button>
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						disabled={index >= total - 1}
						onClick={onNext}
						aria-label="Next record"
					>
						<ChevronRight />
					</Button>
				</div>
			</SheetFooter>
		</>
	);
}
