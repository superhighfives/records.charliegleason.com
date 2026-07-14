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
import { BadgeCheck, ChevronDownIcon, EllipsisVertical } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Sheet, SheetContent } from "#/components/ui/sheet";
import { UnmatchedBadge } from "#/components/unmatched-badge";
import type { Record } from "#/db/schema";
import { describeAnalysisError } from "#/lib/analysis-error";
import { displayCoverKey } from "#/lib/cover";
import {
	deleteRecord,
	deleteRecords,
	refreshRecords,
	retryRecords,
} from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";
import { effectiveValue, formatMoney } from "#/lib/value";

type RecordStatus = NonNullable<Record["status"]>;
type FacetTest = (r: Record, liveIds: Set<number>) => boolean;
interface FacetOption {
	token: string;
	label: string;
	test: FacetTest;
}

// Filters are independent facets combined with AND. The tri-state segmented pairs let
// you pick one side, the other, or neither (= don't care); the flag pills below are
// simple on/off. Each token belongs to a group, and only one token per group is active.
const FACET_GROUPS: Array<{
	key: string;
	options: [FacetOption, FacetOption];
}> = [
	{
		key: "publish",
		options: [
			{
				token: "published",
				label: "Published",
				test: (r) => (r.status ?? "complete") === "complete",
			},
			{
				token: "unpublished",
				label: "Unpublished",
				test: (r) => (r.status ?? "complete") !== "complete",
			},
		],
	},
	{
		key: "match",
		options: [
			{ token: "matched", label: "Matched", test: (r) => r.discogsId != null },
			{
				token: "unmatched",
				label: "Unmatched",
				test: (r) => r.discogsId == null,
			},
		],
	},
	{
		key: "value",
		options: [
			{
				token: "valued",
				label: "Valued",
				test: (r) => effectiveValue(r) != null,
			},
			{
				token: "unvalued",
				label: "Unvalued",
				test: (r) => effectiveValue(r) == null,
			},
		],
	},
	{
		key: "confirm",
		options: [
			{
				token: "confirmed",
				label: "Confirmed",
				test: (r) => r.confirmedRelease === true,
			},
			{
				token: "unconfirmed",
				label: "Unconfirmed",
				test: (r) => r.confirmedRelease !== true,
			},
		],
	},
	{
		key: "photo",
		options: [
			{
				token: "hasPhoto",
				label: "Has photo",
				test: (r) => r.professionalImageKey != null,
			},
			{
				token: "usingUpload",
				label: "Using upload",
				test: (r) => r.coverIsUpload === true,
			},
		],
	},
];

// Attention states that aren't clean opposites — simple on/off toggles.
const FLAG_FACETS: FacetOption[] = [
	{
		token: "review",
		label: "Needs review",
		test: (r) => (r.status ?? "complete") === "review",
	},
	{ token: "failed", label: "Failed", test: (r) => r.status === "failed" },
	{
		token: "duplicate",
		label: "Duplicate",
		test: (r, live) => r.duplicateOf != null && live.has(r.duplicateOf),
	},
];

// Per-flag accent colours (needs review = purple, failed = red, duplicate = orange),
// for both the active (filled) and idle (outlined) states.
const FLAG_COLORS: globalThis.Record<string, { active: string; idle: string }> =
	{
		review: {
			active: "border-purple-600 bg-purple-600 text-white",
			idle: "border-purple-500/40 text-purple-600 hover:bg-purple-500/10 dark:text-purple-400",
		},
		failed: {
			active: "border-red-600 bg-red-600 text-white",
			idle: "border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400",
		},
		duplicate: {
			active: "border-orange-600 bg-orange-600 text-white",
			idle: "border-orange-500/40 text-orange-600 hover:bg-orange-500/10 dark:text-orange-400",
		},
	};

// token → its option + the group it belongs to (flags are their own single-token group).
const TOKEN_INFO: globalThis.Record<
	string,
	{ option: FacetOption; groupKey: string }
> = {};
for (const g of FACET_GROUPS)
	for (const o of g.options)
		TOKEN_INFO[o.token] = { option: o, groupKey: g.key };
for (const f of FLAG_FACETS)
	TOKEN_INFO[f.token] = { option: f, groupKey: f.token };

/** Parse the `f` search param into active tokens: known only, at most one per group. */
function parseFacetTokens(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw) return [];
	const groups = new Set<string>();
	const out: string[] = [];
	for (const t of raw.split(",")) {
		const info = TOKEN_INFO[t];
		if (!info || groups.has(info.groupKey)) continue;
		groups.add(info.groupKey);
		out.push(t);
	}
	return out;
}

/** A record matches when every active facet's test passes (AND). */
function matchesFacets(
	r: Record,
	active: string[],
	liveIds: Set<number>,
): boolean {
	return active.every((t) => TOKEN_INFO[t].option.test(r, liveIds));
}

/** How many records an option would show, honouring the *other* groups' active facets. */
function facetCount(
	rows: Record[],
	active: string[],
	option: FacetOption,
	groupKey: string,
	liveIds: Set<number>,
): number {
	const others = active.filter((t) => TOKEN_INFO[t].groupKey !== groupKey);
	return rows.filter(
		(r) =>
			others.every((t) => TOKEN_INFO[t].option.test(r, liveIds)) &&
			option.test(r, liveIds),
	).length;
}

/** Toggle a token: off if already on, else select it (replacing any sibling in its group). */
function toggleFacet(active: string[], token: string): string[] {
	if (active.includes(token)) return active.filter((t) => t !== token);
	const { groupKey } = TOKEN_INFO[token];
	return [...active.filter((t) => TOKEN_INFO[t].groupKey !== groupKey), token];
}

// Bulk row actions. Each hands the selected ids to a single batched server
// endpoint (one round trip, not N parallel calls). `match` re-queues analysis
// (for unmatched/failed/captured rows — re-reads the cover and re-searches
// Discogs), `refresh` enqueues a Discogs re-pull for already-matched rows,
// `delete` removes them. Each endpoint returns how many rows it acted on.
type BulkAction = "match" | "refresh" | "delete";
const BULK_ACTIONS: {
	[K in BulkAction]: {
		label: string;
		verb: string; // past tense, for the result toast: "3 records <verb>."
		fn: (opts: { data: number[] }) => Promise<{ count: number }>;
		destructive?: boolean;
		// Only meaningful for already-matched rows (those with a Discogs release);
		// the button disables when the selection contains none.
		requiresMatch?: boolean;
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
					? "Try different filters, or clear the search."
					: "Add one with “Add manually”, or capture a record."}
			</p>
		</div>
	);
}

/** One tri-state segmented pair — pick a side, the other, or neither (= don't care). */
function SegmentedFilter({
	group,
	active,
	rows,
	liveIds,
	onToggle,
}: {
	group: { key: string; options: [FacetOption, FacetOption] };
	active: string[];
	rows: Record[];
	liveIds: Set<number>;
	onToggle: (token: string) => void;
}) {
	return (
		<div className="inline-flex shrink-0 items-stretch overflow-hidden rounded-full border">
			{group.options.map((opt, i) => {
				const isActive = active.includes(opt.token);
				const count = facetCount(rows, active, opt, group.key, liveIds);
				return (
					<Fragment key={opt.token}>
						{i === 1 && (
							<span aria-hidden className="w-px self-stretch bg-border" />
						)}
						<button
							type="button"
							onClick={() => onToggle(opt.token)}
							className={cn(
								"whitespace-nowrap px-3 py-1 text-xs transition-colors",
								isActive
									? "bg-foreground text-background"
									: "text-muted-foreground hover:bg-accent",
							)}
						>
							{opt.label}{" "}
							<span className="tabular-nums opacity-70">{count}</span>
						</button>
					</Fragment>
				);
			})}
		</div>
	);
}

export const Route = createFileRoute("/admin/")({
	// Deep-link the active facets (a comma list in `f`) so back/forward and shared URLs
	// restore the filter; an empty selection drops the param to keep the URL clean.
	validateSearch: (
		search: globalThis.Record<string, unknown>,
	): { f?: string } => {
		const tokens = parseFacetTokens(search.f);
		return tokens.length ? { f: tokens.join(",") } : {};
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

	// The active facets live in the URL (?f=token,token) so they survive navigating into
	// a record and pressing back, and can be shared/bookmarked.
	const { f: rawFacets } = Route.useSearch();
	const activeFacets = useMemo(() => parseFacetTokens(rawFacets), [rawFacets]);
	const setFacets = (tokens: string[]) =>
		navigate({
			to: "/admin",
			search: (prev) => ({
				...prev,
				f: tokens.length ? tokens.join(",") : undefined,
			}),
			replace: true,
		});
	const toggleFilter = (token: string) =>
		setFacets(toggleFacet(activeFacets, token));
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
					// Approved professional photo, then the raw capture, then the
					// Discogs cover — so the list shows the record actually
					// photographed unless a professional shot has gone live.
					const key = displayCoverKey(row.original, {
						includeCapture: true,
						preferCapture: true,
					});
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
					<div className="flex justify-end">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Row actions"
									onClick={(e) => e.stopPropagation()}
								>
									<EllipsisVertical className="size-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem asChild>
									<Link
										to="/admin/records/$id"
										params={{ id: String(row.original.id) }}
									>
										View
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem
									variant="destructive"
									onSelect={() => {
										if (confirm(`Delete "${row.original.title}"?`)) {
											deleteMutation.mutate(row.original.id);
										}
									}}
								>
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				),
			},
		],
		[liveIds, deleteMutation.mutate],
	);

	// Filter, then float the records that still need attention to the top
	// (newest first). User-driven column sorting still overrides this default.
	const rows = useMemo(
		() =>
			data
				.filter((r) => matchesFacets(r, activeFacets, liveIds))
				.sort((a, b) => {
					const pa = STATUS_PRIORITY[a.status ?? "complete"];
					const pb = STATUS_PRIORITY[b.status ?? "complete"];
					if (pa !== pb) return pa - pb;
					return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
				}),
		[data, activeFacets, liveIds],
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
	// A facet/search filter is narrowing things when there's data but nothing shown.
	const isFiltered =
		data.length > 0 &&
		(activeFacets.length > 0 || debouncedFilter.trim() !== "");

	// Quick-view drawer: page through exactly what's on screen (the table's sorted +
	// filtered rows), tracked by id so re-sorting never jumps to the wrong record.
	const previewRecords = table.getRowModel().rows.map((r) => r.original);
	const previewIndex =
		previewId == null
			? -1
			: previewRecords.findIndex((r) => r.id === previewId);
	const previewRecord = previewIndex >= 0 ? previewRecords[previewIndex] : null;

	// Keep rendering the last-open record while the drawer slides shut. Radix keeps
	// the sheet mounted through its exit animation, but `previewRecord` goes null the
	// instant we close — without this, the body would vanish before the slide-out.
	const lastPreview = useRef<{
		record: (typeof previewRecords)[number];
		index: number;
	}>(null);
	if (previewRecord)
		lastPreview.current = { record: previewRecord, index: previewIndex };
	const shownPreview = previewRecord
		? { record: previewRecord, index: previewIndex }
		: lastPreview.current;

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

					{/* Facet filters live in a popover so the header stays a single tidy row
					    on mobile. The trigger badges the active count; the panel holds the
					    tri-state segmented pairs + on/off flags, combined with AND. Each
					    pill shows how many records that option would leave, honouring the
					    other groups already picked. */}
					<Popover>
						<PopoverTrigger asChild>
							<Button
								variant="outline"
								className="flex-1 sm:flex-none"
								aria-label="Filters"
							>
								Filters
								{activeFacets.length > 0 && (
									<span className="rounded-full bg-foreground px-1.5 text-xs tabular-nums text-background">
										{activeFacets.length}
									</span>
								)}
								<ChevronDownIcon className="size-4 opacity-60" />
							</Button>
						</PopoverTrigger>
						<PopoverContent
							align="end"
							className="w-[min(24rem,calc(100vw-2rem))] space-y-2"
						>
							<div className="flex flex-wrap items-center gap-2">
								{FACET_GROUPS.map((group) => (
									<SegmentedFilter
										key={group.key}
										group={group}
										active={activeFacets}
										rows={data}
										liveIds={liveIds}
										onToggle={toggleFilter}
									/>
								))}
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{FLAG_FACETS.map((flag) => {
									const isActive = activeFacets.includes(flag.token);
									const count = facetCount(
										data,
										activeFacets,
										flag,
										flag.token,
										liveIds,
									);
									const color = FLAG_COLORS[flag.token];
									return (
										<button
											key={flag.token}
											type="button"
											onClick={() => toggleFilter(flag.token)}
											className={cn(
												"shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors",
												isActive ? color.active : color.idle,
											)}
										>
											{flag.label}{" "}
											<span className="tabular-nums opacity-70">{count}</span>
										</button>
									);
								})}
								{activeFacets.length > 0 && (
									<button
										type="button"
										onClick={() => setFacets([])}
										className="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
									>
										Clear
									</button>
								)}
							</div>
						</PopoverContent>
					</Popover>

					{/* Split primary action: "Capture record" is the common path; the caret
					    tucks the rarer "Add manually" behind a dropdown. */}
					<div className="flex flex-1 sm:flex-none">
						<Button asChild className="flex-1 rounded-r-none sm:flex-none">
							<Link to="/admin/capture">Capture record</Link>
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									aria-label="More add options"
									className="rounded-l-none border-l border-neutral-900/20 px-2"
								>
									<ChevronDownIcon className="size-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem asChild>
									<Link to="/admin/records/new">Add manually</Link>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</div>

			{/* Bulk actions. The bar stays put whenever there are rows to act on (so
			    ticking the first row doesn't shift the table down), but the action
			    buttons + Clear only appear once something is selected — no row of
			    greyed-out disabled controls at rest. The min-height keeps the bar the
			    same size whether or not the (button-height) actions are showing, so
			    selecting a row doesn't resize it. Hidden entirely when empty. */}
			{visibleRowCount > 0 && (
				<div className="flex min-h-14 sticky top-4 z-10 items-center gap-2 rounded-lg border border-sidebar-accent bg-sidebar/80 px-5 py-2">
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
									const { label, destructive, requiresMatch } =
										BULK_ACTIONS[action];
									const needsMatch = requiresMatch && !hasMatchedSelection;
									return (
										<Button
											key={action}
											type="button"
											size="sm"
											variant={destructive ? "destructive" : "outline"}
											disabled={bulkMutation.isPending || needsMatch}
											title={
												needsMatch
													? "Only matched records can be refreshed from Discogs."
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
														BULK_ACTIONS[action].requiresMatch &&
														!hasMatchedSelection
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
					const thumb = displayCoverKey(r, {
						includeCapture: true,
						preferCapture: true,
					});
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
					{shownPreview && (
						<RecordPanel
							key={shownPreview.record.id}
							admin
							record={shownPreview.record}
							index={shownPreview.index}
							total={previewRecords.length}
							onPrev={() => {
								const prev = previewRecords[shownPreview.index - 1];
								if (prev) setPreviewId(prev.id);
							}}
							onNext={() => {
								const next = previewRecords[shownPreview.index + 1];
								if (next) setPreviewId(next.id);
							}}
						/>
					)}
				</SheetContent>
			</Sheet>
		</div>
	);
}
