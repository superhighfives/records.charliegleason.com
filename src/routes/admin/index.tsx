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
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import { useMemo, useRef, useState } from "react";

import { DuplicateBadge } from "#/components/duplicate-badge";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type { Record } from "#/db/schema";
import { describeAnalysisError } from "#/lib/analysis-error";
import { deleteRecord, rescanAllRecords } from "#/lib/records";
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
 * The title cell / card heading. A record has no title until analysis writes one,
 * so fall back to the failure reason for `failed` rows (rather than the misleading
 * "Processing…") and to "Processing…" while it's still in flight.
 */
function RecordTitle({ record }: { record: Record }) {
	if (record.title) return <>{record.title}</>;
	if (record.status === "failed") {
		return (
			<span className="italic text-destructive">
				{describeAnalysisError(record.error).message}
			</span>
		);
	}
	return <span className="text-muted-foreground italic">Processing…</span>;
}

function matchesFilter(status: RecordStatus, filter: StatusFilter): boolean {
	if (filter === "all") return true;
	if (filter === "unpublished") return isUnpublished(status);
	return status === filter;
}

export const Route = createFileRoute("/admin/")({
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

	const [filter, setFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [sorting, setSorting] = useState<SortingState>([]);
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
							className="size-10 min-w-10 rounded object-cover"
						/>
					) : (
						<div className="size-10 min-w-10 rounded bg-muted" />
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
		// `globalFilter` is a read-only controlled value fed by the debounced search
		// box. We deliberately don't wire `onGlobalFilterChange` back to `setFilter`:
		// the table reads the *debounced* value but the setter writes the *raw* one,
		// and that 200ms mismatch let react-table re-fire the setter in a loop.
		state: { globalFilter: debouncedFilter, sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});

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
							onClick={() => setStatusFilter(f.value)}
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
				{table.getRowModel().rows.length === 0 && (
					<li className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-muted-foreground">
						No records yet. Add one with “Add manually”, or via the photo flow.
					</li>
				)}
			</ul>

			{/* Desktop: the full sortable table. */}
			<table className="hidden w-full border-collapse text-sm md:table">
				<thead>
					{table.getHeaderGroups().map((hg) => (
						<tr key={hg.id} className="border-b text-left">
							{hg.headers.map((header) => (
								<th key={header.id} className="px-3 py-2 font-medium">
									{header.isPlaceholder ? null : (
										<button
											type="button"
											className="flex items-center gap-1 disabled:cursor-default"
											disabled={!header.column.getCanSort()}
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
									(e.target as HTMLElement).closest("a, button, input")
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
								<td key={cell.id} className="px-3 py-2">
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</td>
							))}
						</tr>
					))}
					{table.getRowModel().rows.length === 0 && (
						<tr>
							<td
								colSpan={columns.length}
								className="px-3 py-8 text-center text-muted-foreground"
							>
								No records yet. Add one with “New record”, or via the photo
								flow.
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}
