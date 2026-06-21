import { useHotkeys } from "@tanstack/react-hotkeys";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { createFileRoute } from "@tanstack/react-router";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	useReactTable,
} from "@tanstack/react-table";
import { useRef, useState } from "react";
import { Input } from "#/components/ui/input";
import type { Record } from "#/db/schema";
import { listRecords } from "#/lib/records";

export const Route = createFileRoute("/admin/")({
	loader: () => listRecords(),
	component: AdminRecords,
});

const columns: Array<ColumnDef<Record>> = [
	{ accessorKey: "artist", header: "Artist" },
	{ accessorKey: "title", header: "Title" },
	{ accessorKey: "year", header: "Year" },
	{ accessorKey: "label", header: "Label" },
	{
		accessorKey: "pitchforkScore",
		header: "Pitchfork",
		cell: ({ getValue }) => getValue<number | null>() ?? "—",
	},
];

function AdminRecords() {
	const data = Route.useLoaderData();
	const searchRef = useRef<HTMLInputElement>(null);

	const [filter, setFilter] = useState("");
	// Pacer: debounce the global filter so typing doesn't re-filter on every keystroke.
	const [debouncedFilter] = useDebouncedValue(filter, { wait: 200 });

	// Hotkeys: press "/" to jump to the search box.
	useHotkeys([
		{
			hotkey: "/",
			callback: (e) => {
				e.preventDefault();
				searchRef.current?.focus();
			},
		},
	]);

	const table = useReactTable({
		data,
		columns,
		state: { globalFilter: debouncedFilter },
		onGlobalFilterChange: setFilter,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	});

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-semibold">Collection</h1>
				<Input
					ref={searchRef}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="Filter records…  ( / )"
					className="max-w-xs"
				/>
			</div>

			<table className="w-full border-collapse text-sm">
				<thead>
					{table.getHeaderGroups().map((hg) => (
						<tr key={hg.id} className="border-b text-left">
							{hg.headers.map((header) => (
								<th key={header.id} className="px-3 py-2 font-medium">
									{flexRender(
										header.column.columnDef.header,
										header.getContext(),
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
								No records yet. Add some via the photo flow or the API.
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}
