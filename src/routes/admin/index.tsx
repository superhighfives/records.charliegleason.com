import { useHotkeys } from "@tanstack/react-hotkeys";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type RowSelectionState,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import { BadgeCheck, ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DuplicateBadge } from "#/components/duplicate-badge";
import { RecordPanel } from "#/components/record-panel";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Sheet, SheetContent } from "#/components/ui/sheet";
import { UnmatchedBadge } from "#/components/unmatched-badge";
import type { Record } from "#/db/schema";
import { describeAnalysisError } from "#/lib/analysis-error";
import { displayCoverKey } from "#/lib/cover";
import {
	deleteRecord,
	deleteRecords,
	generateProfessionalPhotos,
	refreshRecords,
	rescanAllRecords,
	retryRecords,
} from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";
import { effectiveValue, formatMoney } from "#/lib/value";

type RecordStatus = NonNullable<Record["status"]>;
type StatusFilter =
	| RecordStatus
	| "all"
	| "unpublished"
	| "unmatched"
	| "duplicate"
	| "confirmed";

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "unpublished", label: "Unpublished" },
	{ value: "pending", label: "Queued" },
	{ value: "processing", label: "Analyzing" },
	{ value: "review", label: "Needs review" },
	{ value: "unmatched", label: "Unmatched" },
	{ value: "failed", label: "Failed" },
	{ value: "complete", label: "Published" },
	{ value: "duplicate", label: "Duplicate" },
	{ value: "confirmed", label: "Confirmed" },
];

const STATUS_FILTER_VALUES = STATUS_FILTERS.map((f) => f.value);

// Bulk row actions. Each hands the selected ids to a single batched server
// endpoint (one round trip, not N parallel calls). `match` re-queues analysis
// (for unmatched/failed/captured rows — re-reads the cover and re-searches
// Discogs), `refresh` enqueues a Discogs re-pull for already-matched rows,
// `delete` removes them. Each endpoint returns how many rows it acted on.
type BulkAction = "match" | "refresh" | "professional" | "delete";
const BULK_ACTIONS: {
	[K in BulkAction]: {
		label: string;
		verb: string; // past tense, for the result toast: "3 records <verb>."
		fn: (opts: { data: number[] }) => Promise<{ count: number }>;
		destructive?: boolean;
		// Only meaningful for already-matched rows (those with a Discogs release);
		// the button disables when the selection contains none.
		requiresMatch?: boolean;
		// Only meaningful for rows with an iPhone capture to work from; the button
		// disables when the selection contains none.
		requiresCapture?: boolean;
	};
} = {
	match: {
		label: "Match",
		verb: "queued for matching",
		fn: retryRecords,
	},
	refresh: {
		label: "Refresh",
		verb: "queued for refresh",
		fn: refreshRecords,
		requiresMatch: true,
	},
	professional: {
		label: "Professional",
		verb: "queued for a professional photo",
		fn: generateProfessionalPhotos,
		requiresCapture: true,
	},
	delete: {
		label: "Delete",
		verb: "deleted",
		fn: deleteRecords,
		destructive: true,
	},
};

// Float the records that still need attention to the top of the default view,
// newest first, so a capture session lands ready to review without sorting.
const STATUS_PRIORITY: globalThis.Record<RecordStatus, number> = {
	review: 0,
	failed: 1,
	pending: 2,
	processing: 3,
	complete: 4,
};

const isUnpublished = (status: RecordStatus) => status !== "complete";

/**
 * The title cell / card heading. A record has no title until analysis writes one.
 * For `failed` rows we show a neutral placeholder (rather than the misleading
 * "Processing…") — the failure reason rides alongside the status badge instead,
 * see {@link StatusError} — and "Processing…" while it's still in flight.
 */
function RecordTitle({ record }: { record: Record }) {
	if (record.title) return <>{record.title}</>;
	if (record.status === "failed")
		return <span className="text-muted-foreground">—</span>;
	return <span className="text-muted-foreground italic">Processing…</span>;
}

/**
 * The failure reason, as quiet supplementary text next to the status badge — so a
 * failed row reads as "[Failed] why it failed" rather than a wall of red in the
 * title column. Empty for any non-failed row.
 */
function StatusError({ record }: { record: Record }) {
	if (record.status !== "failed") return null;
	const { message } = describeAnalysisError(record.error);
	return (
		<span
			className="min-w-0 max-w-[20rem] truncate text-xs text-muted-foreground"
			title={message}
		>
			{message}
		</span>
	);
}

/**
 * Empty-list message. Distinguishes a genuinely empty collection from a tab /
 * search that just happens to match nothing, so the copy is never misleading.
 */
function EmptyState({ filtered }: { filtered: boolean }) {
	return (
		<div className="space-y-1">
			<p className="font-medium text-foreground">
				{filtered ? "No records match your filters" : "No records yet"}
			</p>
			<p className="text-sm text-muted-foreground">
				{filtered
					? "Try a different tab, or clear the search."
					: "Add one with “Add manually”, or capture a record."}
			</p>
		</div>
	);
}

function matchesFilter(
	record: Record,
	filter: StatusFilter,
	liveIds: Set<number>,
): boolean {
	const status = record.status ?? "complete";
	if (filter === "all") return true;
	if (filter === "unpublished") return isUnpublished(status);
	// "Unmatched" and "Duplicate" aren't real statuses — they're derived flags.
	// Mirror the badge conditions (see UnmatchedBadge / DuplicateBadge in the
	// status cell) so a tab and its badge always agree on what counts.
	if (filter === "unmatched") return status === "review" && !record.discogsId;
	if (filter === "duplicate")
		return record.duplicateOf != null && liveIds.has(record.duplicateOf);
	if (filter === "confirmed") return record.confirmedRelease === true;
	return status === filter;
}

export const Route = createFileRoute("/admin/")({
	// Deep-link the active tab so back/forward and shared URLs restore the filter.
	// `all` is the default, so we drop it from the URL to keep things clean.
	validateSearch: (
		search: globalThis.Record<string, unknown>,
	): { status?: StatusFilter } => {
		const status = search.status as StatusFilter | undefined;
		return status && status !== "all" && STATUS_FILTER_VALUES.includes(status)
			? { status }
			: {};
	},
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(recordsQueryOptions),
	component: AdminRecords,
});

function AdminRecords() {
	const { data } = useSuspenseQuery(recordsQueryOptions);
	// Ids still in the collection, so a record whose `duplicateOf` points at a
	// since-deleted original stops claiming to be a duplicate. Memoised so the
	// derived `columns` below keep a stable identity between renders.
	const liveIds = useMemo(() => new Set(data.map((r) => r.id)), [data]);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const searchRef = useRef<HTMLInputElement>(null);

	// The active tab lives in the URL (?status=…) so it survives navigating into a
	// record and pressing back, and can be shared/bookmarked.
	const { status: statusFilter = "all" } = Route.useSearch();
	const [filter, setFilter] = useState("");
	const [sorting, setSorting] = useState<SortingState>([]);
	// Bulk selection, keyed by record id (see `getRowId`) so a selection survives
	// re-sorts and tab switches rather than tracking to whatever row an index lands on.
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
	// Quick-view drawer, tracked by record id so paging/re-sorting can't desync it.
	const [previewId, setPreviewId] = useState<number | null>(null);

	// Collection value totals (USD). `total` sums every record's effective value
	// (manual if set, else the Discogs guess); `confirmedTotal` counts only records
	// with a hand-entered value. Drives the header summary.
	const totals = useMemo(() => {
		let total = 0;
		let confirmedTotal = 0;
		let valued = 0;
		for (const r of data) {
			const v = effectiveValue(r);
			if (v == null) continue;
			total += v;
			valued += 1;
			if (r.manualValue != null) confirmedTotal += v;
		}
		return { total, confirmedTotal, valued };
	}, [data]);
	// Pacer: debounce the global filter so typing doesn't re-filter every keystroke.
	const [debouncedFilter] = useDebouncedValue(filter, { wait: 200 });

	const deleteMutation = useMutation({
		mutationFn: (id: number) => deleteRecord({ data: id }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: recordsQueryOptions.queryKey }),
	});

	// Bulk "Rescan all": re-pull every published record from its stored Discogs
	// release through the queue. Non-destructive; results land as the queue drains.
	const rescanMutation = useMutation({
		mutationFn: () => rescanAllRecords(),
	});

	// Selected-rows actions: hand the ids to the matching batched endpoint and
	// report a single summary toast off the count it actually acted on.
	const bulkMutation = useMutation({
		mutationFn: ({ action, ids }: { action: BulkAction; ids: number[] }) =>
			BULK_ACTIONS[action].fn({ data: ids }),
		onSuccess: async ({ count }, { action }) => {
			await queryClient.invalidateQueries({
				queryKey: recordsQueryOptions.queryKey,
			});
			setRowSelection({});
			const { verb } = BULK_ACTIONS[action];
			toast.success(`${count} ${count === 1 ? "record" : "records"} ${verb}.`);
		},
		onError: (_error, { action }) => {
			toast.error(`Couldn't ${action} the selected records.`);
		},
	});

	// Hotkeys: "/" focuses the search box.
	useHotkeys([
		{
			hotkey: "/",
			callback: (e) => {
				e.preventDefault();
				searchRef.current?.focus();
			},
		},
	]);

	// react-table memoises its row models against the identity of `columns` and
	// `data`. Rebuilding either inline on every render (as this used to) can spin
	// the table into an infinite recompute/re-render loop when other state changes
	// — so both are memoised to a stable reference.
	const columns: Array<ColumnDef<Record>> = useMemo(
		() => [
			{
				id: "select",
				enableSorting: false,
				// Select-all lives in the bulk toolbar (see the "Select all" button
				// there), so the header is visually empty — but keep a screen-reader
				// label so the column still has an accessible name.
				header: () => <span className="sr-only">Select</span>,
				cell: ({ row }) => (
					// Absolutely fills the whole cell so clicking anywhere in the first
					// column toggles the row. The row's navigate-to-detail guard skips
					// clicks landing on a <label>, so this doesn't also open the record.
					<label
						htmlFor={`select-${row.id}`}
						className="absolute inset-0 flex cursor-pointer items-center justify-center"
					>
						<Checkbox
							id={`select-${row.id}`}
							aria-label="Select record"
							checked={row.getIsSelected()}
							onChange={row.getToggleSelectedHandler()}
						/>
					</label>
				),
			},
			{
				id: "cover",
				header: "",
				enableSorting: false,
				cell: ({ row }) => {
					// Approved professional photo, then the sourced cover, then the
					// capture (admin only) — same order the public site uses.
					const key = displayCoverKey(row.original, { includeCapture: true });
					// The thumbnail opens the quick-view drawer (a <button>, so the row's
					// navigate-to-detail guard skips it).
					return (
						<button
							type="button"
							aria-label="Quick view"
							onClick={() => setPreviewId(row.original.id)}
							className="block rounded transition-opacity hover:opacity-80"
						>
							{key ? (
								<img
									src={`/api/photos/${key}`}
									alt=""
									className="size-10 min-w-10 rounded object-cover"
								/>
							) : (
								<div className="size-10 min-w-10 rounded bg-muted" />
							)}
						</button>
					);
				},
			},
			{
				accessorKey: "artist",
				header: "Artist",
				cell: ({ getValue }) =>
					getValue<string>() || (
						<span className="text-muted-foreground">—</span>
					),
			},
			{
				accessorKey: "title",
				header: "Title",
				cell: ({ row }) => <RecordTitle record={row.original} />,
			},
			{ accessorKey: "year", header: "Year" },
			{ accessorKey: "label", header: "Label" },
			{
				accessorKey: "pitchforkScore",
				header: "Pitchfork",
				cell: ({ getValue }) => getValue<number | null>() ?? "—",
			},
			{
				id: "value",
				header: "Value",
				// The effective value: manual (confirmed) figure if set, else the guess.
				accessorFn: (row) => effectiveValue(row),
				cell: ({ row }) => {
					const value = effectiveValue(row.original);
					if (value == null)
						return <span className="text-muted-foreground">—</span>;
					return (
						<span
							className="tabular-nums"
							title={
								row.original.manualValue != null
									? "Confirmed (manual) value"
									: "Estimated from Discogs"
							}
						>
							{formatMoney(value, row.original.discogsValueCurrency ?? "USD")}
						</span>
					);
				},
			},
			{
				id: "confirmed",
				header: "Confirmed",
				accessorFn: (row) => (row.confirmedRelease ? 1 : 0),
				cell: ({ row }) =>
					row.original.confirmedRelease ? (
						<BadgeCheck
							className="size-4 text-brand-strong"
							aria-label="Confirmed release"
						/>
					) : (
						<span className="text-muted-foreground">—</span>
					),
			},
			{
				accessorKey: "status",
				header: "Status",
				cell: ({ row }) => (
					<Link
						to="/admin/records/$id"
						params={{ id: String(row.original.id) }}
						className="inline-flex flex-wrap items-center gap-1"
					>
						<StatusBadge status={row.original.status} />
						{row.original.status === "review" && !row.original.discogsId && (
							<UnmatchedBadge />
						)}
						{row.original.duplicateOf != null &&
							liveIds.has(row.original.duplicateOf) && <DuplicateBadge />}
						<StatusError record={row.original} />
					</Link>
				),
			},
			{
				id: "actions",
				header: "",
				enableSorting: false,
				cell: ({ row }) => (
					<div className="flex justify-end gap-2">
						<Link
							to="/admin/records/$id"
							params={{ id: String(row.original.id) }}
							className="text-sm text-brand underline underline-offset-4 hover:text-brand-strong"
						>
							View
						</Link>
						<button
							type="button"
							className="text-sm text-destructive underline underline-offset-4 disabled:opacity-50"
							disabled={deleteMutation.isPending}
							onClick={(e) => {
								e.stopPropagation();
								if (confirm(`Delete "${row.original.title}"?`)) {
									deleteMutation.mutate(row.original.id);
								}
							}}
						>
							Delete
						</button>
					</div>
				),
			},
		],
		[liveIds, deleteMutation.isPending, deleteMutation.mutate],
	);

	// Filter, then float the records that still need attention to the top
	// (newest first). User-driven column sorting still overrides this default.
	const rows = useMemo(
		() =>
			data
				.filter((r) => matchesFilter(r, statusFilter, liveIds))
				.sort((a, b) => {
					const pa = STATUS_PRIORITY[a.status ?? "complete"];
					const pb = STATUS_PRIORITY[b.status ?? "complete"];
					if (pa !== pb) return pa - pb;
					return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
				}),
		[data, statusFilter, liveIds],
	);

	const table = useReactTable({
		data: rows,
		columns,
		// Key rows by record id so a selection stays pinned to the record, not the
		// slot, when the list re-sorts or the tab changes.
		getRowId: (r) => String(r.id),
		enableRowSelection: true,
		// `globalFilter` is a read-only controlled value fed by the debounced search
		// box. We deliberately don't wire `onGlobalFilterChange` back to `setFilter`:
		// the table reads the *debounced* value but the setter writes the *raw* one,
		// and that 200ms mismatch let react-table re-fire the setter in a loop.
		state: { globalFilter: debouncedFilter, sorting, rowSelection },
		onSortingChange: setSorting,
		onRowSelectionChange: setRowSelection,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});

	// Selected ids for the bulk toolbar. `getSelectedRowModel` is built off the
	// core row model and would include rows the text filter is hiding; the
	// filtered variant keeps the toolbar in step with what's actually on screen
	// (and with the visible-only select-all).
	const selectedRows = table.getFilteredSelectedRowModel().rows;
	const selectedIds = selectedRows.map((r) => r.original.id);
	const hasSelection = selectedIds.length > 0;
	// Refresh only re-pulls Discogs metadata for already-matched rows, so it's
	// disabled unless the selection contains at least one record with a match.
	const hasMatchedSelection = selectedRows.some(
		(r) => r.original.discogsId != null,
	);
	// The professional photo is generated from the iPhone capture, so it's
	// disabled unless the selection contains at least one record with one.
	const hasCaptureSelection = selectedRows.some(
		(r) => r.original.capturePhotoKey != null,
	);
	// Rows visible under the current tab + search. Drives the empty state and
	// whether the bulk toolbar is worth showing at all.
	const visibleRowCount = table.getRowModel().rows.length;
	// True once every currently-visible (filtered) row is selected — hides the
	// toolbar's "Select all" once there's nothing left for it to add.
	const allVisibleSelected =
		visibleRowCount > 0 && selectedRows.length === visibleRowCount;
	// Selects every currently-visible (filtered) row, so "select all" never
	// reaches into rows the tab/search filter is hiding.
	const selectAllVisible = () => {
		for (const r of table.getRowModel().rows) r.toggleSelected(true);
	};
	// A search/tab filter is narrowing things when there's data but nothing shown.
	const isFiltered =
		data.length > 0 &&
		(statusFilter !== "all" || debouncedFilter.trim() !== "");

	// Quick-view drawer: page through exactly what's on screen (the table's sorted +
	// filtered rows), tracked by id so re-sorting never jumps to the wrong record.
	const previewRecords = table.getRowModel().rows.map((r) => r.original);
	const previewIndex =
		previewId == null
			? -1
			: previewRecords.findIndex((r) => r.id === previewId);
	const previewRecord = previewIndex >= 0 ? previewRecords[previewIndex] : null;

	// If the previewed record drops out of the filtered view, forget it entirely so
	// a later search can't silently re-open it.
	useEffect(() => {
		if (previewId != null && previewIndex === -1) setPreviewId(null);
	}, [previewId, previewIndex]);

	// Run a bulk action against the current selection, confirming first for the
	// destructive ones. Shared by the desktop buttons and the mobile menu.
	const runBulkAction = (action: BulkAction) => {
		if (
			BULK_ACTIONS[action].destructive &&
			!confirm(
				`Delete ${selectedIds.length} ${
					selectedIds.length === 1 ? "record" : "records"
				}? This can't be undone.`,
			)
		) {
			return;
		}
		bulkMutation.mutate({ action, ids: selectedIds });
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Collection</h1>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Total value{" "}
						<span className="font-medium tabular-nums text-foreground">
							{formatMoney(totals.total, "USD")}
						</span>{" "}
						across {totals.valued} {totals.valued === 1 ? "record" : "records"}
						{totals.confirmedTotal > 0 && (
							<>
								{" "}
								·{" "}
								<span className="tabular-nums">
									{formatMoney(totals.confirmedTotal, "USD")}
								</span>{" "}
								confirmed
							</>
						)}
					</p>
				</div>
				<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
					<Input
						ref={searchRef}
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter records…  ( / )"
						className="w-full sm:w-56"
					/>
					<Button
						type="button"
						variant="outline"
						className="flex-1 sm:flex-none"
						disabled={rescanMutation.isPending}
						onClick={() => {
							if (
								confirm(
									"Re-pull every published record from Discogs? This runs in the background.",
								)
							) {
								rescanMutation.mutate();
							}
						}}
					>
						{rescanMutation.isPending
							? "Queuing…"
							: rescanMutation.data
								? `Queued ${rescanMutation.data.queued}`
								: "Rescan all"}
					</Button>
					<Button asChild variant="outline" className="flex-1 sm:flex-none">
						<Link to="/admin/records/new">Add manually</Link>
					</Button>
					<Button asChild className="flex-1 sm:flex-none">
						<Link to="/admin/capture">Capture record</Link>
					</Button>
				</div>
			</div>

			<div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
				{STATUS_FILTERS.map((f) => {
					const count = data.filter((r) =>
						matchesFilter(r, f.value, liveIds),
					).length;
					const active = statusFilter === f.value;
					return (
						<button
							key={f.value}
							type="button"
							onClick={() =>
								navigate({
									to: "/admin",
									// Switching tabs replaces history so it doesn't pile up entries;
									// only navigating into a record pushes, so back returns here.
									search: (prev) => ({
										...prev,
										status: f.value === "all" ? undefined : f.value,
									}),
									replace: true,
								})
							}
							className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs ${
								active
									? "border-foreground bg-foreground text-background"
									: "text-muted-foreground hover:bg-accent"
							}`}
						>
							{f.label} ({count})
						</button>
					);
				})}
			</div>

			{/* Bulk actions. The bar stays put whenever there are rows to act on (so
			    ticking the first row doesn't shift the table down), but the action
			    buttons + Clear only appear once something is selected — no row of
			    greyed-out disabled controls at rest. The min-height keeps the bar the
			    same size whether or not the (button-height) actions are showing, so
			    selecting a row doesn't resize it. Hidden entirely when empty. */}
			{visibleRowCount > 0 && (
				<div className="flex min-h-14 sticky top-4 z-10 items-center gap-2 rounded-lg border border-sidebar-accent bg-sidebar/50 backdrop-blur px-3 py-2">
					{hasSelection ? (
						<span className="text-sm font-medium whitespace-nowrap">
							{selectedIds.length} selected
						</span>
					) : (
						<span className="text-sm font-medium whitespace-nowrap text-muted-foreground">
							No items selected
						</span>
					)}

					{hasSelection && (
						<>
							{/* Desktop: the actions inline. */}
							<div className="hidden items-center gap-2 sm:flex">
								{(Object.keys(BULK_ACTIONS) as BulkAction[]).map((action) => {
									const { label, destructive, requiresMatch, requiresCapture } =
										BULK_ACTIONS[action];
									const needsMatch = requiresMatch && !hasMatchedSelection;
									const needsCapture = requiresCapture && !hasCaptureSelection;
									return (
										<Button
											key={action}
											type="button"
											size="sm"
											variant={destructive ? "destructive" : "outline"}
											disabled={
												bulkMutation.isPending || needsMatch || needsCapture
											}
											title={
												needsMatch
													? "Only matched records can be refreshed from Discogs."
													: needsCapture
														? "Only records with a capture photo can get a professional photo."
														: undefined
											}
											onClick={() => runBulkAction(action)}
										>
											{label}
										</Button>
									);
								})}
							</div>

							{/* Mobile: the same actions collapsed into a dropdown so the
							    toolbar stays on one row. */}
							<div className="sm:hidden">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											size="sm"
											variant="outline"
											disabled={bulkMutation.isPending}
										>
											Actions
											<ChevronDownIcon className="opacity-50" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start">
										{(Object.keys(BULK_ACTIONS) as BulkAction[]).map(
											(action) => (
												<DropdownMenuItem
													key={action}
													variant={
														BULK_ACTIONS[action].destructive
															? "destructive"
															: "default"
													}
													disabled={
														(BULK_ACTIONS[action].requiresMatch &&
															!hasMatchedSelection) ||
														(BULK_ACTIONS[action].requiresCapture &&
															!hasCaptureSelection)
													}
													onSelect={() => runBulkAction(action)}
												>
													{BULK_ACTIONS[action].label}
												</DropdownMenuItem>
											),
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</>
					)}

					{/* Right-aligned selection controls. "Select all" grabs every
					    filtered row; it drops away once they're all selected. "Clear"
					    only shows when there's something to clear. */}
					<div className="ml-auto flex items-center gap-3">
						{!allVisibleSelected && (
							<button
								type="button"
								className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
								onClick={selectAllVisible}
							>
								Select all
							</button>
						)}
						{hasSelection && (
							<button
								type="button"
								className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
								onClick={() => setRowSelection({})}
							>
								Clear
							</button>
						)}
					</div>
				</div>
			)}

			{/* Mobile: stacked cards (the wide table doesn't fit a phone). */}
			<ul className="space-y-2 md:hidden">
				{table.getRowModel().rows.map((row) => {
					const r = row.original;
					const thumb = displayCoverKey(r, { includeCapture: true });
					return (
						<li
							key={row.id}
							className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-accent/40"
						>
							<label
								htmlFor={`select-m-${row.id}`}
								className="-m-1 flex shrink-0 cursor-pointer items-center p-1"
							>
								<Checkbox
									id={`select-m-${row.id}`}
									aria-label="Select record"
									checked={row.getIsSelected()}
									onChange={row.getToggleSelectedHandler()}
								/>
							</label>
							{/* Link wraps only the non-destructive content; the Delete button is
							    a sibling so we don't nest interactive elements inside an <a>. */}
							<button
								type="button"
								aria-label="Quick view"
								onClick={() => setPreviewId(r.id)}
								className="shrink-0 rounded"
							>
								{thumb ? (
									<img
										src={`/api/photos/${thumb}`}
										alt=""
										className="size-14 shrink-0 rounded object-cover"
									/>
								) : (
									<div className="size-14 shrink-0 rounded bg-muted" />
								)}
							</button>
							<Link
								to="/admin/records/$id"
								params={{ id: String(r.id) }}
								className="flex min-w-0 flex-1 items-center gap-3"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium">
										<RecordTitle record={r} />
									</p>
									<p className="truncate text-sm text-muted-foreground">
										{r.artist || "—"}
										{r.year ? ` · ${r.year}` : ""}
									</p>
									<div className="mt-1.5 flex flex-wrap items-center gap-1">
										<StatusBadge status={r.status} />
										{r.status === "review" && !r.discogsId && (
											<UnmatchedBadge />
										)}
										{r.duplicateOf != null && <DuplicateBadge />}
										{r.pitchforkScore != null && (
											<span className="text-xs text-muted-foreground tabular-nums">
												Pitchfork {r.pitchforkScore}
											</span>
										)}
										<StatusError record={r} />
									</div>
								</div>
							</Link>
							<button
								type="button"
								className="shrink-0 self-start text-sm text-destructive underline underline-offset-4 disabled:opacity-50"
								disabled={deleteMutation.isPending}
								onClick={() => {
									if (confirm(`Delete "${r.title || "this record"}"?`)) {
										deleteMutation.mutate(r.id);
									}
								}}
							>
								Delete
							</button>
						</li>
					);
				})}
				{visibleRowCount === 0 && (
					<li className="rounded-lg border border-dashed border-border px-3 py-10 text-center">
						<EmptyState filtered={isFiltered} />
					</li>
				)}
			</ul>

			{/* Desktop: the full sortable table. */}
			<table className="hidden w-full border-collapse text-sm md:table">
				<thead>
					{table.getHeaderGroups().map((hg) => (
						<tr key={hg.id} className="border-b text-left">
							{hg.headers.map((header) => (
								<th
									key={header.id}
									className={
										// The select column drops its padding and goes `relative` so the
										// checkbox label can absolutely fill it; a fixed width keeps the
										// padding-free cell from collapsing.
										header.column.id === "select"
											? "relative w-12 p-0 font-medium"
											: "px-3 py-2 font-medium"
									}
								>
									{header.isPlaceholder ? null : header.column.getCanSort() ? (
										<button
											type="button"
											className="flex items-center gap-1"
											onClick={header.column.getToggleSortingHandler()}
										>
											{flexRender(
												header.column.columnDef.header,
												header.getContext(),
											)}
											{{ asc: " ↑", desc: " ↓" }[
												header.column.getIsSorted() as string
											] ?? null}
										</button>
									) : (
										// Non-sortable headers (the select checkbox, cover, actions)
										// render bare — wrapping them in a disabled <button> both nests
										// interactive controls illegally and swallows the checkbox's clicks.
										flexRender(
											header.column.columnDef.header,
											header.getContext(),
										)
									)}
								</th>
							))}
						</tr>
					))}
				</thead>
				<tbody>
					{table.getRowModel().rows.map((row) => (
						<tr
							key={row.id}
							className="cursor-pointer border-b hover:bg-accent/40"
							onClick={(e) => {
								// Pointer convenience only — keyboard users (and screen readers)
								// use the real links in the row. Let nested links/buttons handle
								// their own clicks, and don't hijack ⌘/Ctrl/Shift-click (which
								// the links use to open in a new tab).
								if (
									e.metaKey ||
									e.ctrlKey ||
									e.shiftKey ||
									(e.target as HTMLElement).closest("a, button, input, label")
								) {
									return;
								}
								navigate({
									to: "/admin/records/$id",
									params: { id: String(row.original.id) },
								});
							}}
						>
							{row.getVisibleCells().map((cell) => (
								<td
									key={cell.id}
									className={
										// Padding-free + `relative` so the checkbox label fills the cell;
										// the fixed width stops the otherwise-empty cell collapsing.
										cell.column.id === "select"
											? "relative w-12 p-0"
											: "px-3 py-2"
									}
								>
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</td>
							))}
						</tr>
					))}
					{visibleRowCount === 0 && (
						<tr>
							<td colSpan={columns.length} className="px-3 py-12 text-center">
								<EmptyState filtered={isFiltered} />
							</td>
						</tr>
					)}
				</tbody>
			</table>

			{/* Quick-view drawer — the same panel the public site uses, in admin mode
			    so it surfaces the private valuation + confirmed-release status. */}
			<Sheet
				open={previewRecord != null}
				onOpenChange={(open) => {
					if (!open) setPreviewId(null);
				}}
			>
				<SheetContent className="p-0">
					{previewRecord && (
						<RecordPanel
							key={previewRecord.id}
							admin
							record={previewRecord}
							index={previewIndex}
							total={previewRecords.length}
							onPrev={() =>
								previewIndex > 0 &&
								setPreviewId(previewRecords[previewIndex - 1].id)
							}
							onNext={() =>
								previewIndex < previewRecords.length - 1 &&
								setPreviewId(previewRecords[previewIndex + 1].id)
							}
						/>
					)}
				</SheetContent>
			</Sheet>
		</div>
	);
}
