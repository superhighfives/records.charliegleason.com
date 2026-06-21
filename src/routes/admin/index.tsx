import { useHotkeys } from "@tanstack/react-hotkeys";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type { Record } from "#/db/schema";
import { deleteRecord } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/admin/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(recordsQueryOptions),
	component: AdminRecords,
});

function AdminRecords() {
	const { data } = useSuspenseQuery(recordsQueryOptions);
	const queryClient = useQueryClient();
	const searchRef = useRef<HTMLInputElement>(null);

	const [filter, setFilter] = useState("");
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
		{ accessorKey: "artist", header: "Artist" },
		{ accessorKey: "title", header: "Title" },
		{ accessorKey: "year", header: "Year" },
		{ accessorKey: "label", header: "Label" },
		{
			accessorKey: "pitchforkScore",
			header: "Pitchfork",
			cell: ({ getValue }) => getValue<number | null>() ?? "—",
		},
		{
			id: "actions",
			header: "",
			enableSorting: false,
			cell: ({ row }) => (
				<div className="flex justify-end gap-2">
					<Link
						to="/admin/records/$id/edit"
						params={{ id: String(row.original.id) }}
						className="text-sm underline underline-offset-4"
					>
						Edit
					</Link>
					<button
						type="button"
						className="text-sm text-destructive underline underline-offset-4 disabled:opacity-50"
						disabled={deleteMutation.isPending}
						onClick={() => {
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

	const table = useReactTable({
		data,
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
					<Button asChild>
						<Link to="/admin/records/new">New record</Link>
					</Button>
				</div>
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
						<tr key={row.id} className="border-b">
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
