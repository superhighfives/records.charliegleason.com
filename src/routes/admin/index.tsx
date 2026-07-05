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
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DuplicateBadge } from "#/components/duplicate-badge";
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
import type { Record } from "#/db/schema";
import { describeAnalysisError } from "#/lib/analysis-error";
import {
	deleteRecord,
	deleteRecords,
	refreshRecords,
	rescanAllRecords,
	retryRecords,
} from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

type RecordStatus = NonNullable<Record["status"]>;
type StatusFilter = RecordStatus | "all" | "unpublished";

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "unpublished", label: "Unpublished" },
	{ value: "pending", label: "Queued" },
	{ value: "processing", label: "Analyzing" },
	{ value: "review", label: "Needs review" },
	{ value: "failed", label: "Failed" },
	{ value: "complete", label: "Published" },
];

const STATUS_FILTER_VALUES = STATUS_FILTERS.map((f) => f.value);

// Bulk row actions. Each hands the selected ids to a single batched server
// endpoint (one round trip, not N parallel calls). `retry` re-queues analysis
// (for failed/captured rows), `refresh` enqueues a Discogs re-pull, `delete`
// removes them. Each endpoint returns how many rows it actually acted on.
type BulkAction = "retry" | "refresh" | "delete";
const BULK_ACTIONS: {
	[K in BulkAction]: {
		label: string;
		verb: string; // past tense, for the result toast: "3 records <verb>."
		fn: (opts: { data: number[] }) => Promise<{ count: number }>;
		destructive?: boolean;
	};
} = {
	retry: { label: "Retry", verb: "queued for retry", fn: retryRecords },
	refresh: { label: "Refresh", verb: "queued for refresh", fn: refreshRecords },
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

function matchesFilter(status: RecordStatus, filter: StatusFilter): boolean {
	if (filter === "all") return true;
	if (filter === "unpublished") return isUnpublished(status);
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
				// Header toggles every currently-visible (filtered) row, so "select all"
				// never reaches into rows the text filter is hiding.
				header: ({ table }) => {
					const rows = table.getRowModel().rows;
					const allSelected =
						rows.length > 0 && rows.every((r) => r.getIsSelected());
					const someSelected = rows.some((r) => r.getIsSelected());
					return (
						// Absolutely fills the (padding-free, `relative`) header cell so the
						// entire box is a hit target for select-all.
						<label
							htmlFor="select-all"
							className="absolute inset-0 flex cursor-pointer items-center justify-center"
						>
							<Checkbox
								id="select-all"
								aria-label="Select all"
								checked={allSelected}
								indeterminate={someSelected && !allSelected}
								onChange={(e) => {
									const value = e.target.checked;
									for (const r of rows) r.toggleSelected(value);
								}}
							/>
						</label>
					);
				},
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
					// Prefer the sourced/resized cover; fall back to the capture (admin only).
					const key =
						row.original.coverImageKey ?? row.original.capturePhotoKey;
					return key ? (
						<img
							src={`/api/photos/${key}`}
							alt=""
							className="size-10 rounded object-cover"
						/>
					) : (
						<div className="size-10 rounded bg-muted" />
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
				accessorKey: "status",
				header: "Status",
				cell: ({ row }) => (
					<Link
						to="/admin/records/$id"
						params={{ id: String(row.original.id) }}
						className="inline-flex flex-wrap items-center gap-1"
					>
						<StatusBadge status={row.original.status} />
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
				.filter((r) => matchesFilter(r.status ?? "complete", statusFilter))
				.sort((a, b) => {
					const pa = STATUS_PRIORITY[a.status ?? "complete"];
					const pb = STATUS_PRIORITY[b.status ?? "complete"];
					if (pa !== pb) return pa - pb;
					return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
				}),
		[data, statusFilter],
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
	const selectedIds = table
		.getFilteredSelectedRowModel()
		.rows.map((r) => r.original.id);
	const hasSelection = selectedIds.length > 0;
	// Rows visible under the current tab + search. Drives the empty state and
	// whether the bulk toolbar is worth showing at all.
	const visibleRowCount = table.getRowModel().rows.length;
	// A search/tab filter is narrowing things when there's data but nothing shown.
	const isFiltered =
		data.length > 0 &&
		(statusFilter !== "all" || debouncedFilter.trim() !== "");

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
				<h1 className="text-2xl font-semibold">Collection</h1>
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
						matchesFilter(r.status ?? "complete", f.value),
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

			{/* Bulk actions. Rendered whenever there are rows to act on — even at
			    0 selected (with disabled buttons) — so ticking the first row doesn't
			    shift the table down. Hidden entirely when the list is empty. */}
			{visibleRowCount > 0 && (
				<div className="flex items-center gap-2 rounded-lg border border-border bg-accent/40 px-3 py-2">
					<span className="text-sm font-medium whitespace-nowrap">
						{selectedIds.length} selected
					</span>

					{/* Desktop: the actions inline. */}
					<div className="hidden items-center gap-2 sm:flex">
						{(Object.keys(BULK_ACTIONS) as BulkAction[]).map((action) => {
							const { label, destructive } = BULK_ACTIONS[action];
							return (
								<Button
									key={action}
									type="button"
									size="sm"
									variant={destructive ? "destructive" : "outline"}
									disabled={!hasSelection || bulkMutation.isPending}
									onClick={() => runBulkAction(action)}
								>
									{label}
								</Button>
							);
						})}
					</div>

					{/* Mobile: the same actions collapsed into a dropdown so the toolbar
				    stays on one row. */}
					<div className="sm:hidden">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={!hasSelection || bulkMutation.isPending}
								>
									Actions
									<ChevronDownIcon className="opacity-50" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start">
								{(Object.keys(BULK_ACTIONS) as BulkAction[]).map((action) => (
									<DropdownMenuItem
										key={action}
										variant={
											BULK_ACTIONS[action].destructive
												? "destructive"
												: "default"
										}
										onSelect={() => runBulkAction(action)}
									>
										{BULK_ACTIONS[action].label}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					<button
						type="button"
						className="ml-auto text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
						disabled={!hasSelection}
						onClick={() => setRowSelection({})}
					>
						Clear
					</button>
				</div>
			)}

			{/* Mobile: stacked cards (the wide table doesn't fit a phone). */}
			<ul className="space-y-2 md:hidden">
				{table.getRowModel().rows.map((row) => {
					const r = row.original;
					const thumb = r.coverImageKey ?? r.capturePhotoKey;
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
							<Link
								to="/admin/records/$id"
								params={{ id: String(r.id) }}
								className="flex min-w-0 flex-1 items-center gap-3"
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
		</div>
	);
}
