import { useHotkeys } from "@tanstack/react-hotkeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckIcon, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Pager } from "#/components/pager";
import { RecordLoading } from "#/components/spinning-record";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type { Record } from "#/db/schema";
import { displayCoverKey } from "#/lib/cover";
import type { DiscogsCandidate } from "#/lib/discogs-shared";
import {
	getDiscogsMasterVersions,
	pinPressing,
	setManualValue,
} from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";
import { effectiveValue, formatMoney } from "#/lib/value";

export const Route = createFileRoute("/admin/catalog")({
	component: CatalogPage,
});

/** Catalog numbers compare loosely: Discogs and sleeves differ in case and spacing. */
const normCatno = (s: string | null | undefined) =>
	(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Walk the records that have no pinned pressing, one at a time, in shelf order
 * (artist, then title), and pin each one to the exact pressing in hand. Discogs
 * only prices a specific pressing, so this is what gets a record into the
 * collection total. Picking a pressing queues its value fetch; a hand-entered
 * value covers anything Discogs can't price.
 *
 * The queue is a snapshot taken when the page loads, so a record stays under the
 * cursor (marked done) after it's pinned instead of vanishing from the list.
 */
function CatalogPage() {
	const queryClient = useQueryClient();
	const [queueIds, setQueueIds] = useState<number[] | null>(null);
	const [index, setIndex] = useState(0);

	// After a pin, poll for up to two minutes so the queued value fetch shows up
	// without a reload. The queue retries a failed fetch for about that long.
	const [polling, setPolling] = useState(false);
	useEffect(() => {
		if (!polling) return;
		const timer = setTimeout(() => setPolling(false), 120_000);
		return () => clearTimeout(timer);
	}, [polling]);
	const { data: all = [], isFetchedAfterMount } = useQuery({
		...recordsQueryOptions,
		refetchInterval: polling ? 3000 : false,
	});

	useEffect(() => {
		if (queueIds != null || all.length === 0) return;
		setQueueIds(
			all
				.filter((r) => r.discogsId == null)
				.sort(
					(a, b) =>
						a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
				)
				.map((r) => r.id),
		);
	}, [all, queueIds]);

	const byId = useMemo(() => new Map(all.map((r) => [r.id, r])), [all]);
	const record = queueIds ? byId.get(queueIds[index]) : undefined;
	const done = queueIds?.filter((id) => byId.get(id)?.discogsId).length ?? 0;
	const total = useMemo(
		() => all.reduce((sum, r) => sum + (effectiveValue(r) ?? 0), 0),
		[all],
	);

	const go = (next: number) => {
		if (!queueIds) return;
		setIndex(Math.min(Math.max(next, 0), queueIds.length - 1));
	};
	useHotkeys(
		[
			{ hotkey: "ArrowLeft", callback: () => go(index - 1) },
			{ hotkey: "ArrowRight", callback: () => go(index + 1) },
		],
		{ preventDefault: false },
	);

	// Write the server's row back into the list cache, so the page (and the admin
	// list's total) reflect a pin or a manual value at once.
	const storeRow = (row: Record | null) => {
		if (!row) return;
		queryClient.setQueryData(recordsQueryOptions.queryKey, (list) =>
			list?.map((r) => (r.id === row.id ? row : r)),
		);
	};

	if (queueIds == null) {
		if (all.length === 0 && isFetchedAfterMount) {
			return <p className="text-muted-foreground">No records yet.</p>;
		}
		return <RecordLoading label="Loading collection…" />;
	}

	return (
		<div className="mx-auto w-full max-w-3xl space-y-4">
			<header className="flex flex-wrap items-end justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-lg font-semibold">Catalog</h1>
					<p className="text-sm text-muted-foreground">
						Pin each record to the pressing you own so Discogs can value it.{" "}
						<span className="tabular-nums">
							{done} of {queueIds.length}
						</span>{" "}
						pinned · collection total{" "}
						<span className="font-medium tabular-nums text-foreground">
							{formatMoney(total, "USD")}
						</span>
					</p>
				</div>
				<Pager
					index={index}
					total={queueIds.length}
					hasPrev={index > 0}
					hasNext={index < queueIds.length - 1}
					onPrev={() => go(index - 1)}
					onNext={() => go(index + 1)}
					noun="record"
				/>
			</header>

			{queueIds.length === 0 ? (
				<p className="text-muted-foreground">
					Every record has a pinned pressing.
				</p>
			) : record ? (
				<CatalogItem
					key={record.id}
					record={record}
					fetching={polling}
					onPinned={(row) => {
						storeRow(row);
						setPolling(true);
						toast.success("Pinned. Fetching its value from Discogs.");
					}}
					onValueSaved={storeRow}
					onNext={() => go(index + 1)}
				/>
			) : (
				<p className="text-muted-foreground">This record was deleted.</p>
			)}
		</div>
	);
}

function CatalogItem({
	record,
	fetching,
	onPinned,
	onValueSaved,
	onNext,
}: {
	record: Record;
	fetching: boolean;
	onPinned: (row: Record | null) => void;
	onValueSaved: (row: Record | null) => void;
	onNext: () => void;
}) {
	const [filter, setFilter] = useState("");
	const [manual, setManual] = useState(record.manualValue?.toString() ?? "");

	const versionsQuery = useQuery({
		queryKey: ["master-versions", record.masterId] as const,
		queryFn: () => getDiscogsMasterVersions({ data: record.masterId ?? "" }),
		enabled: record.masterId != null,
		staleTime: 5 * 60 * 1000,
	});

	// A catalog number read off the sleeve during analysis is the strongest hint,
	// so matching pressings go first.
	const versions = useMemo(() => {
		const q = filter.trim().toLowerCase();
		const hint = normCatno(record.catno);
		return (versionsQuery.data ?? [])
			.filter(
				(v) =>
					!q ||
					[v.catno, v.country, v.label, v.format, v.year?.toString()]
						.filter(Boolean)
						.some((f) => f?.toLowerCase().includes(q)),
			)
			.sort(
				(a, b) =>
					Number(hint !== "" && normCatno(b.catno) === hint) -
					Number(hint !== "" && normCatno(a.catno) === hint),
			);
	}, [versionsQuery.data, filter, record.catno]);

	const pin = useMutation({
		mutationFn: (v: DiscogsCandidate) =>
			pinPressing({ data: { id: record.id, discogsId: v.discogsId } }),
		onSuccess: onPinned,
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Couldn't pin that pressing.",
			),
	});

	const saveManual = useMutation({
		mutationFn: () => {
			const amount = manual.trim() === "" ? null : Number(manual);
			if (amount != null && !(Number.isFinite(amount) && amount >= 0)) {
				throw new Error("Enter a positive amount, or leave it empty.");
			}
			return setManualValue({ data: { id: record.id, value: amount } });
		},
		onSuccess: (row) => {
			onValueSaved(row);
			toast.success(
				row?.manualValue != null ? "Saved the value." : "Cleared the value.",
			);
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Couldn't save the value.",
			),
	});

	const coverKey = displayCoverKey(record, { includeCapture: true });
	const value = effectiveValue(record);

	return (
		<div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
			<div className="space-y-3">
				{coverKey ? (
					<img
						src={`/api/photos/${coverKey}`}
						alt=""
						className="aspect-square w-full rounded-md object-cover"
					/>
				) : (
					<div className="aspect-square w-full rounded-md bg-muted" />
				)}
				<div className="space-y-0.5">
					<p className="font-medium">{record.artist}</p>
					<p className="text-sm">{record.title}</p>
					<p className="text-xs text-muted-foreground">
						{[record.year, record.label, record.catno]
							.filter(Boolean)
							.join(" · ")}
					</p>
				</div>
				<div className="space-y-1 rounded-md border border-border p-3 text-sm">
					<p className="text-xs font-medium text-muted-foreground">Value</p>
					<p className="tabular-nums">
						{value == null &&
						record.discogsId &&
						record.discogsValueFetchedAt == null ? (
							fetching ? (
								<span className="inline-flex items-center gap-1.5 text-muted-foreground">
									<Loader2 className="size-3.5 animate-spin" />
									Fetching from Discogs…
								</span>
							) : (
								<span className="text-muted-foreground">
									No value yet. Use “Fetch values” on the list to retry.
								</span>
							)
						) : value != null ? (
							<>
								{formatMoney(value, record.discogsValueCurrency ?? "USD")}{" "}
								<span className="text-muted-foreground">
									{record.manualValue != null ? "confirmed" : "Discogs"}
								</span>
							</>
						) : record.discogsId ? (
							<span className="text-muted-foreground">
								Nothing for sale on Discogs
							</span>
						) : (
							<span className="text-muted-foreground">
								Pin a pressing, or enter a value
							</span>
						)}
					</p>
					<form
						className="flex gap-2 pt-1"
						onSubmit={(e) => {
							e.preventDefault();
							saveManual.mutate();
						}}
					>
						<Input
							value={manual}
							onChange={(e) => setManual(e.target.value)}
							inputMode="decimal"
							placeholder="Your value, USD"
							aria-label="Your value in USD"
							className="h-8"
						/>
						<Button
							type="submit"
							size="sm"
							variant="outline"
							disabled={saveManual.isPending}
						>
							Save
						</Button>
					</form>
				</div>
				<div className="flex gap-2">
					<Button type="button" size="sm" onClick={onNext}>
						Next record
					</Button>
					<Button asChild size="sm" variant="ghost">
						<Link to="/admin/records/$id" params={{ id: String(record.id) }}>
							Open in editor
						</Link>
					</Button>
				</div>
			</div>

			<div className="min-w-0 space-y-2">
				{record.masterId == null ? (
					<p className="text-sm text-muted-foreground">
						This record has no album link yet. Open it in the editor to match it
						first.
					</p>
				) : (
					<>
						<Input
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter by catalog number, country, label or year"
							aria-label="Filter pressings"
						/>
						{versionsQuery.isPending ? (
							<p className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="size-4 animate-spin" />
								Loading pressings…
							</p>
						) : versionsQuery.isError ? (
							<p className="text-sm text-destructive">
								Couldn't load pressings: {versionsQuery.error.message}
							</p>
						) : versions.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No vinyl pressings match. Try a different filter, or open the
								record in the editor to search Discogs.
							</p>
						) : (
							<ul className="divide-y divide-border rounded-md border border-border">
								{versions.map((v) => {
									const pinned = v.discogsId === record.discogsId;
									const hinted =
										normCatno(record.catno) !== "" &&
										normCatno(v.catno) === normCatno(record.catno);
									return (
										<li
											key={v.discogsId}
											className={cn(
												"flex items-center gap-3 p-2",
												pinned && "bg-muted",
											)}
										>
											{v.thumb ? (
												<img
													src={v.thumb}
													alt=""
													className="size-10 shrink-0 rounded object-cover"
												/>
											) : (
												<div className="size-10 shrink-0 rounded bg-muted" />
											)}
											<div className="min-w-0 flex-1 text-sm">
												<p className="truncate">
													{[v.catno, v.country, v.year]
														.filter(Boolean)
														.join(" · ")}
													{hinted && (
														<span className="ml-2 text-xs text-brand">
															matches the sleeve
														</span>
													)}
												</p>
												<p className="truncate text-xs text-muted-foreground">
													{[v.label, v.format].filter(Boolean).join(" · ")}
												</p>
											</div>
											<a
												href={v.discogsUrl}
												target="_blank"
												rel="noreferrer"
												className="text-xs text-muted-foreground underline underline-offset-4"
											>
												Discogs
											</a>
											<Button
												type="button"
												size="sm"
												variant={pinned ? "secondary" : "outline"}
												disabled={pinned || pin.isPending}
												onClick={() => pin.mutate(v)}
											>
												{pinned ? <CheckIcon /> : null}
												{pinned ? "Pinned" : "Pin"}
											</Button>
										</li>
									);
								})}
							</ul>
						)}
					</>
				)}
			</div>
		</div>
	);
}
