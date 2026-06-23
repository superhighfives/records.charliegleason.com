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
import { useRef, useState } from "react";

import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type { Record } from "#/db/schema";
import { deleteRecord } from "#/lib/records";
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

	const columns: Array<ColumnDef<Record>> = [
		{
			id: "cover",
			header: "",
			enableSorting: false,
			cell: ({ row }) => {
				// Prefer the sourced/resized cover; fall back to the capture (admin only).
				const key = row.original.coverImageKey ?? row.original.capturePhotoKey;
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
				getValue<string>() || <span className="text-muted-foreground">—</span>,
		},
		{
			accessorKey: "title",
			header: "Title",
			cell: ({ getValue }) =>
				getValue<string>() || (
					<span className="text-muted-foreground italic">Processing…</span>
				),
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
					className="inline-block"
				>
					<StatusBadge status={row.original.status} />
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
						className="text-sm underline underline-offset-4"
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
	];

	// Filter, then float the records that still need attention to the top
	// (newest first). User-driven column sorting still overrides this default.
	const rows = data
		.filter((r) => matchesFilter(r.status ?? "complete", statusFilter))
		.sort((a, b) => {
			const pa = STATUS_PRIORITY[a.status ?? "complete"];
			const pb = STATUS_PRIORITY[b.status ?? "complete"];
			if (pa !== pb) return pa - pb;
			return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
		});

	const table = useReactTable({
		data: rows,
		columns,
		state: { globalFilter: debouncedFilter, sorting },
		onGlobalFilterChange: setFilter,
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel(),
	});

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-2xl font-semibold">Collection</h1>
				<div className="flex items-center gap-2">
					<Input
						ref={searchRef}
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter records…  ( / )"
						className="max-w-xs"
					/>
					<Button asChild variant="outline">
						<Link to="/admin/records/new">Add manually</Link>
					</Button>
					<Button asChild>
						<Link to="/admin/capture">Capture record</Link>
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap gap-2">
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
							className={`rounded-full border px-3 py-1 text-xs ${
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

			<table className="w-full border-collapse text-sm">
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
							onClick={() =>
								navigate({
									to: "/admin/records/$id",
									params: { id: String(row.original.id) },
								})
							}
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
