import {
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
import { displayCoverKey, type PublicRecord } from "#/lib/cover";

/** The public shape — the homepage never sees the admin-only capture photo. */
export type PanelRecord = PublicRecord;

/** A headline fact rendered as a bordered card (the OpenRouter-style stat grid). */
function Stat({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="rounded-lg border border-border p-3">
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
}: {
	record: PanelRecord;
	index: number;
	total: number;
	onPrev: () => void;
	onNext: () => void;
}) {
	// `copied` resets on its own: the panel is keyed by record id at the call site,
	// so paging to another record remounts this component with a fresh state.
	const [copied, setCopied] = useState(false);

	const copyCatno = async () => {
		if (!record.catno) return;
		try {
			await navigator.clipboard.writeText(record.catno);
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
			<SheetHeader className="flex-row items-start gap-4 pb-2 pr-10">
				<div className="size-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
					{(() => {
						const cover = displayCoverKey(record);
						return cover ? (
							<img
								src={`/api/photos/${cover}`}
								alt=""
								className="size-full object-cover"
							/>
						) : null;
					})()}
				</div>
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

			<div className="flex-1 space-y-6 overflow-y-auto px-6 pb-6">
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
