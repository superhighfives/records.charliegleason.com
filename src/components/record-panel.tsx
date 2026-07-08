import {
	BadgeCheck,
	Check,
	ChevronLeft,
	ChevronRight,
	Copy,
	ExternalLink,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "#/components/ui/button";
import {
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import type { Record } from "#/db/schema";
import { displayCoverKey } from "#/lib/cover";
import type { PublicRecord } from "#/lib/records";
import { effectiveValue, formatMoney, parseValueBreakdown } from "#/lib/value";

/**
 * What the panel renders. Public callers pass a {@link PublicRecord} (no
 * capture photo, no valuation); the admin drawer passes a full row and sets
 * `admin` to surface the private valuation fields, which are optional here so
 * both shapes fit.
 */
export type PanelRecord = PublicRecord &
	Partial<
		Pick<
			Record,
			| "confirmedRelease"
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
 * The record detail drawer body — a cover + title header, a grid of headline
 * facts, a specifications list, notes, and prev/next paging through the current
 * (filtered) collection. Rendered inside a `<SheetContent>`.
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
	/** Admin drawer: surface the private valuation + confirmed-release status. */
	admin?: boolean;
}) {
	// `copied` resets on its own: the panel is keyed by record id at the call site,
	// so paging to another record remounts this component with a fresh state.
	const [copied, setCopied] = useState(false);

	// The catalog number is shown, but copying grabs the Discogs release URL (the
	// more useful thing to paste), falling back to the catno when there's no link.
	const copyCatno = async () => {
		const toCopy = record.discogsUrl ?? record.catno;
		if (!toCopy) return;
		try {
			await navigator.clipboard.writeText(toCopy);
			setCopied(true);
		} catch {
			// Clipboard denied (insecure context / permissions) — nothing to do.
		}
	};

	// Clear the "copied" tick after a moment. Driven by an effect so the timer is
	// cancelled on unmount (paging remounts the panel), avoiding a state update on
	// an unmounted component.
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(t);
	}, [copied]);

	const cover = displayCoverKey(record);

	const added = record.createdAt
		? record.createdAt.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			})
		: null;

	// Arrow keys page through the collection (Escape is handled by the Sheet).
	// Ignore keys aimed at a text field / editable element so we don't hijack
	// caret movement, and only swallow the event when we actually page.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
			const el = e.target as HTMLElement | null;
			if (
				el?.isContentEditable ||
				el?.closest("input, textarea, select, [contenteditable='true']")
			) {
				return;
			}
			e.preventDefault();
			if (e.key === "ArrowLeft") onPrev();
			else onNext();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onPrev, onNext]);

	return (
		<>
			<SheetHeader className="flex-row flex-wrap items-start gap-4 pb-6 pr-10 min-[400px]:flex-nowrap mt-auto border-b border-border">
				<div className="min-w-0 flex-1">
					<SheetTitle className="font-serif text-lg leading-tight">
						{record.discogsUrl ? (
							<a
								href={record.discogsUrl}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-baseline gap-1.5 hover:text-brand"
							>
								{record.title}
								<ExternalLink className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
							</a>
						) : (
							record.title
						)}
					</SheetTitle>
					<SheetDescription className="font-serif">
						{record.artist}
						{record.year ? ` · ${record.year}` : ""}
					</SheetDescription>
					{admin && record.confirmedRelease && (
						<span className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-xs font-medium text-brand-strong">
							<BadgeCheck className="size-3.5" />
							Confirmed release
						</span>
					)}
					{record.catno && (
						<button
							type="button"
							onClick={copyCatno}
							className="mt-1 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
						>
							{record.catno}
							{copied ? (
								<Check className="size-3" />
							) : (
								<Copy className="size-3" />
							)}
						</button>
					)}
				</div>
			</SheetHeader>

			<div className="flex-1 overflow-y-auto">
				<div className="aspect-square">
					{cover && (
						<img
							src={`/api/photos/${cover}`}
							alt=""
							className="block size-full object-cover"
						/>
					)}
				</div>
				<div className="p-6 space-y-6">
					<div className="grid grid-cols-3 gap-2">
						<Stat label="Year">{dash(record.year)}</Stat>
						<Stat label="Format">{dash(record.format)}</Stat>
						<Stat label="Size">{dash(record.size)}</Stat>
						<Stat label="Genre">{dash(record.genre)}</Stat>
						<Stat label="Country">{dash(record.country)}</Stat>
					</div>

					<div>
						<h3 className="mb-1 text-sm font-semibold">Specifications</h3>
						<dl className="divide-y divide-border">
							<Spec label="Label">{dash(record.label)}</Spec>
							<Spec label="Catalog number">{dash(record.catno)}</Spec>
							<Spec label="Discogs">
								{record.discogsUrl ? (
									<a
										href={record.discogsUrl}
										target="_blank"
										rel="noreferrer"
										className="inline-flex items-center gap-1 text-brand hover:text-brand-strong"
									>
										View release
										<ExternalLink className="size-3" />
									</a>
								) : (
									"—"
								)}
							</Spec>
							<Spec label="Added">{dash(added)}</Spec>
						</dl>
					</div>

					{admin && <AdminValuation record={record} />}

					{record.pitchforkScore != null && (
						<div>
							<h3 className="mb-1 text-sm font-semibold">Critical reception</h3>
							<p className="text-sm text-muted-foreground">
								{record.pitchforkUrl ? (
									<a
										href={record.pitchforkUrl}
										target="_blank"
										rel="noreferrer"
										className="font-bold tabular-nums text-brand hover:text-brand-strong"
									>
										{record.pitchforkScore}
									</a>
								) : (
									<span className="font-bold tabular-nums text-brand">
										{record.pitchforkScore}
									</span>
								)}{" "}
								on Pitchfork
							</p>
						</div>
					)}

					{record.notes && (
						<div>
							<h3 className="mb-1 text-sm font-semibold">Notes</h3>
							<p className="text-sm text-muted-foreground">{record.notes}</p>
						</div>
					)}
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
