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
	type RowData,
	type RowSelectionState,
	type SortingState,
	type Row as TableRow,
	useReactTable,
} from "@tanstack/react-table";
import { BadgeCheck, ChevronDownIcon, EllipsisVertical } from "lucide-react";
import {
	Fragment,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

import { DuplicateBadge } from "#/components/duplicate-badge";
import { FadeImage } from "#/components/fade-image";
import { GenerationFailedBadge } from "#/components/generation-failed-badge";
import { MatteFallbackBadge } from "#/components/matte-fallback-badge";
import { MatteStaleBadge } from "#/components/matte-stale-badge";
import { RecordPanel } from "#/components/record-panel";
import { RecordLoading } from "#/components/spinning-record";
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
import { duplicateRecordIds } from "#/lib/duplicates";
import { orderRecordsForReview } from "#/lib/record-order";
import {
	deleteRecord,
	deleteRecords,
	publishRecords,
	retryProfessionalGenerations,
	retryProfessionalMattes,
	unpublishRecords,
} from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";
import { effectiveValue, formatMoney } from "#/lib/value";

// Let a column carry an extra Tailwind class, applied to both its <th> and
// <td> — used to hide lower-priority columns (Label, Pitchfork, Value,
// Confirmed) below the `lg` breakpoint so the table stays legible on tablets.
declare module "@tanstack/react-table" {
	interface ColumnMeta<TData extends RowData, TValue> {
		className?: string;
	}
}

type FacetTest = (r: Record, duplicateIds: Set<number>) => boolean;
interface FacetOption {
	token: string;
	label: string;
	test: FacetTest;
}

// Filters are independent facets combined with AND. The tri-state segmented pairs let
// you pick one side, the other, or neither (= don't care); the flag pills below are
// simple on/off. Each token belongs to a group, and only one token per group is active.
// `label` is the row heading in the filter popover (the options carry their own labels).
const FACET_GROUPS: Array<{
	key: string;
	label: string;
	options: FacetOption[];
}> = [
	{
		key: "publish",
		label: "Status",
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
		label: "Match",
		options: [
			// "Matched" now means the record has an album (master) — the identity that
			// makes it publishable. A pinned release is a separate axis (below).
			{ token: "matched", label: "Matched", test: (r) => r.masterId != null },
			{
				token: "unmatched",
				label: "Unmatched",
				test: (r) => r.masterId == null,
			},
		],
	},
	{
		key: "value",
		label: "Value",
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
		key: "notes",
		label: "Notes",
		options: [
			// Admin-authored notes are stored as nullable text; an all-whitespace value
			// counts as empty (matching the record form's trim-min-1 validation).
			{
				token: "hasNotes",
				label: "Has notes",
				test: (r) => (r.notes?.trim() ?? "") !== "",
			},
			{
				token: "noNotes",
				label: "No notes",
				test: (r) => (r.notes?.trim() ?? "") === "",
			},
		],
	},
	{
		key: "color",
		label: "Color",
		options: [
			{ token: "hasColor", label: "Has color", test: (r) => r.colorId != null },
			{ token: "noColor", label: "No color", test: (r) => r.colorId == null },
		],
	},
	{
		key: "release",
		label: "Release",
		options: [
			{
				token: "pinned",
				label: "Release pinned",
				test: (r) => r.discogsId != null,
			},
			{
				token: "albumOnly",
				label: "Album only",
				test: (r) => r.discogsId == null,
			},
		],
	},
	{
		key: "photo",
		label: "Photo",
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
	{
		// Which matte cut the sleeve out. `professionalAlphaSource` is null until Apply
		// runs, then "ai" (the paid matting model) or "deterministic" — the free edge-snap
		// fallback the queue lands when the Magic matte fails. "Lo-fi matte" is thus the same
		// set the old amber "Magic matte failed" flag surfaced, now framed as a matte source
		// alongside its siblings rather than a standalone attention flag.
		key: "matte",
		label: "Matte",
		options: [
			{
				token: "noMatte",
				label: "No matte",
				test: (r) => r.professionalAlphaSource == null,
			},
			{
				token: "aiMatte",
				label: "Magic matte",
				test: (r) => r.professionalAlphaSource === "ai",
			},
			{
				token: "lofiMatte",
				label: "Lo-fi matte",
				test: (r) => r.professionalAlphaSource === "deterministic",
			},
		],
	},
];

// Attention states that aren't clean opposites — simple on/off toggles. (There's
// no "review" flag: the `review` status just means "unpublished" now, which the
// Published/Unpublished filter already covers, and Unmatched flags the no-album case.)
const FLAG_FACETS: FacetOption[] = [
	{
		token: "failed",
		label: "Analysis failed",
		test: (r) => r.status === "failed",
	},
	// The Apply (generation) job errored and stayed failed after the auto-retries — the
	// cover didn't regenerate, so this needs manual action (open + Apply again).
	{
		token: "genFailed",
		label: "Image failed",
		test: (r) => r.professionalJobStatus === "failed",
	},
	// The deterministic-matte-fallback case (paid Magic matte failed) is now the "Lo-fi
	// matte" side of the `matte` facet group above, not a standalone flag.
	{
		token: "duplicate",
		label: "Duplicate",
		test: (r, duplicateIds) => duplicateIds.has(r.id),
	},
];

// Per-flag accent colours (failed = red, duplicate = orange), for both the active
// (filled) and idle (outlined) states.
const FLAG_COLORS: globalThis.Record<string, { active: string; idle: string }> =
	{
		failed: {
			active: "border-red-600 bg-red-600 text-white",
			idle: "border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400",
		},
		genFailed: {
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
	duplicateIds: Set<number>,
): boolean {
	return active.every((t) => TOKEN_INFO[t].option.test(r, duplicateIds));
}

/** How many records an option would show, honouring the *other* groups' active facets. */
function facetCount(
	rows: Record[],
	active: string[],
	option: FacetOption,
	groupKey: string,
	duplicateIds: Set<number>,
): number {
	const others = active.filter((t) => TOKEN_INFO[t].groupKey !== groupKey);
	return rows.filter(
		(r) =>
			others.every((t) => TOKEN_INFO[t].option.test(r, duplicateIds)) &&
			option.test(r, duplicateIds),
	).length;
}

/** Toggle a token: off if already on, else select it (replacing any sibling in its group). */
function toggleFacet(active: string[], token: string): string[] {
	if (active.includes(token)) return active.filter((t) => t !== token);
	const { groupKey } = TOKEN_INFO[token];
	return [...active.filter((t) => TOKEN_INFO[t].groupKey !== groupKey), token];
}

// Bulk row actions. Each hands the selected ids to a single batched server
// endpoint (one round trip, not N parallel calls). `publish` flips rows to
// `complete` (live on the homepage), `unpublish` drops them back to `review`
// (off the homepage, still in the queue), `delete` removes them. Publish and
// unpublish share one toolbar slot — see `bulkActions`. Each endpoint returns
// how many rows it acted on.
type BulkAction =
	| "publish"
	| "unpublish"
	| "retryGeneration"
	| "retryMatte"
	| "delete";
const BULK_ACTIONS: {
	[K in BulkAction]: {
		label: string;
		verb: string; // past tense, for the result toast: "3 records <verb>."
		fn: (opts: { data: number[] }) => Promise<{ count: number }>;
		destructive?: boolean;
	};
} = {
	publish: {
		label: "Publish",
		verb: "published",
		fn: publishRecords,
	},
	unpublish: {
		label: "Unpublish",
		verb: "unpublished",
		fn: unpublishRecords,
	},
	// The count these return can be lower than the selection: the server skips rows with
	// nothing to act on (no capture for regeneration; no cover/capture for the matte), so
	// the toast reflects what was actually re-queued.
	retryGeneration: {
		label: "Retry generation",
		verb: "queued for regeneration",
		fn: retryProfessionalGenerations,
	},
	retryMatte: {
		label: "Retry Magic matte",
		verb: "queued for Magic matte",
		fn: retryProfessionalMattes,
	},
	delete: {
		label: "Delete",
		verb: "deleted",
		fn: deleteRecords,
		destructive: true,
	},
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

/**
 * One desktop table row, memoised so toggling *another* row's selection (or the
 * filter) doesn't re-render all ~290 rows — only the row whose `isSelected` or
 * underlying data actually changed. `isSelected` is passed explicitly so React's
 * memo can see the change; `row` identity is stable while its data is unchanged.
 */
const AdminTableRow = memo(function AdminTableRow({
	row,
	isSelected,
	onNavigate,
}: {
	row: TableRow<Record>;
	isSelected: boolean;
	onNavigate: (id: number) => void;
}) {
	return (
		<tr
			className={cn(
				"cursor-pointer border-b hover:bg-accent/40",
				isSelected && "bg-accent/40",
			)}
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
				onNavigate(row.original.id);
			}}
		>
			{row.getVisibleCells().map((cell) => (
				<td
					key={cell.id}
					className={cn(
						// Padding-free + `relative` so the checkbox label fills the cell;
						// the fixed width stops the otherwise-empty cell collapsing.
						cell.column.id === "select" ? "relative w-12 p-0" : "px-3 py-2",
						cell.column.columnDef.meta?.className,
					)}
				>
					{flexRender(cell.column.columnDef.cell, cell.getContext())}
				</td>
			))}
		</tr>
	);
});

/**
 * Which layout to render — the desktop table or the mobile card list. We render
 * only one (not both hidden behind CSS) so a filter toggle reconciles ~290 rows
 * instead of ~580. Defaults to desktop on the server and first client render so
 * hydration matches; an effect corrects it to the real viewport after mount.
 */
function useIsDesktop() {
	const [isDesktop, setIsDesktop] = useState(true);
	useEffect(() => {
		const mq = window.matchMedia("(min-width: 768px)");
		const update = () => setIsDesktop(mq.matches);
		update();
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	}, []);
	return isDesktop;
}

/** One segmented group — pick a side, another, or none (= don't care). Two options is
 * the common case; the matte group has three. */
function SegmentedFilter({
	group,
	active,
	rows,
	duplicateIds,
	onToggle,
}: {
	group: { key: string; options: FacetOption[] };
	active: string[];
	rows: Record[];
	duplicateIds: Set<number>;
	onToggle: (token: string) => void;
}) {
	return (
		<div className="inline-flex shrink-0 items-stretch overflow-hidden rounded-full border">
			{group.options.map((opt, i) => {
				const isActive = active.includes(opt.token);
				const count = facetCount(rows, active, opt, group.key, duplicateIds);
				return (
					<Fragment key={opt.token}>
						{i > 0 && (
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
	const { data, isFetchedAfterMount } = useSuspenseQuery(recordsQueryOptions);
	// Record ids that look like a duplicate of another record in the *current*
	// collection (same master / release / artist+title — see `duplicateRecordIds`),
	// so the badge + `duplicate` filter reflect live state. Linked copies are
	// excluded. Memoised so the derived `columns` keep a stable identity.
	const duplicateIds = useMemo(() => duplicateRecordIds(data), [data]);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const searchRef = useRef<HTMLInputElement>(null);
	const isDesktop = useIsDesktop();
	// Stable across renders (useNavigate is stable) so the memoised rows don't
	// all re-render when this callback would otherwise be re-created.
	const navigateToRecord = useCallback(
		(id: number) =>
			navigate({ to: "/admin/records/$id", params: { id: String(id) } }),
		[navigate],
	);

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
			toast.error(
				`Couldn't ${BULK_ACTIONS[action].label.toLowerCase()} the selected records.`,
			);
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
								<FadeImage
									src={`/api/photos/${key}`}
									alt=""
									loading="lazy"
									decoding="async"
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
			{
				accessorKey: "label",
				header: "Label",
				meta: { className: "hidden lg:table-cell" },
			},
			{
				accessorKey: "pitchforkScore",
				header: "Pitchfork",
				cell: ({ getValue }) => getValue<number | null>() ?? "—",
				meta: { className: "hidden lg:table-cell" },
			},
			{
				id: "value",
				header: "Value",
				meta: { className: "hidden lg:table-cell" },
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
				id: "release",
				header: "Release",
				meta: { className: "hidden lg:table-cell" },
				accessorFn: (row) => (row.discogsId ? 1 : 0),
				cell: ({ row }) =>
					row.original.discogsId ? (
						<BadgeCheck
							className="size-4 text-brand-strong"
							aria-label="Pinned to a specific release"
						/>
					) : (
						<span
							className="text-muted-foreground"
							title="Album only — no specific release pinned"
						>
							—
						</span>
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
						{/* Unmatched (no album) supersedes the plain "Unpublished" status —
						    show one or the other, not both. */}
						{row.original.status === "review" && !row.original.masterId ? (
							<UnmatchedBadge />
						) : (
							<StatusBadge status={row.original.status} />
						)}
						{duplicateIds.has(row.original.id) && <DuplicateBadge />}
						{row.original.professionalJobStatus === "failed" && (
							<GenerationFailedBadge />
						)}
						{row.original.professionalAlphaSource === "deterministic" && (
							<MatteFallbackBadge />
						)}
						{/* A Magic (AI) matte survives from an earlier completed Apply even
							    when the latest job failed — flag that it may be out of date
							    rather than letting the "Magic matte" filter imply it's current. */}
						{row.original.professionalAlphaSource === "ai" &&
							row.original.professionalJobStatus === "failed" && (
								<MatteStaleBadge />
							)}
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
		[duplicateIds, deleteMutation.mutate],
	);

	// Filter, then float the records that still need attention to the top
	// (newest first). User-driven column sorting still overrides this default.
	const rows = useMemo(
		() =>
			orderRecordsForReview(
				data.filter((r) => matchesFacets(r, activeFacets, duplicateIds)),
			),
		[data, activeFacets, duplicateIds],
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
	// The publish toggle flips direction based on the selection: if every picked
	// row is already live (`complete`) we offer "Unpublish", otherwise "Publish"
	// the ones that aren't. Alongside "Delete" this is the whole bulk toolbar.
	const allPublished =
		hasSelection &&
		selectedRows.every((r) => (r.original.status ?? "complete") === "complete");
	// The two retry actions only appear when the selection actually contains rows they'd
	// act on — a failed generation, or a matte that fell back to the deterministic path —
	// so the toolbar stays uncluttered for a normal selection.
	const anyGenFailed = selectedRows.some(
		(r) => r.original.professionalJobStatus === "failed",
	);
	const anyMatteFallback = selectedRows.some(
		(r) => r.original.professionalAlphaSource === "deterministic",
	);
	const bulkActions: BulkAction[] = [
		allPublished ? "unpublish" : "publish",
		...(anyGenFailed ? (["retryGeneration"] as const) : []),
		...(anyMatteFallback ? (["retryMatte"] as const) : []),
		"delete",
	];
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
		const n = selectedIds.length;
		const noun = n === 1 ? "record" : "records";
		if (
			BULK_ACTIONS[action].destructive &&
			!confirm(`Delete ${n} ${noun}? This can't be undone.`)
		) {
			return;
		}
		// The retries fan out paid background jobs (Real-ESRGAN / the matting model), so
		// confirm before spending on a whole selection — rows with nothing to redo are
		// skipped server-side, so the actual job count may be lower.
		if (
			(action === "retryGeneration" || action === "retryMatte") &&
			!confirm(
				`Re-run ${
					action === "retryMatte" ? "the Magic matte" : "generation"
				} for ${n} selected ${noun}? This runs paid background jobs.`,
			)
		) {
			return;
		}
		bulkMutation.mutate({ action, ids: selectedIds });
	};

	// The list fails soft to `[]` until Clerk resolves the admin session (SSR and the
	// first client paint), so an empty-but-not-yet-fetched collection is really "still
	// loading". Gate on `isFetchedAfterMount` (not the transient `isFetching`): it's
	// false until a client fetch settles after mount — so the SSR-hydrated `[]` shows
	// the spinner on the first paint rather than a one-frame "No records yet" — and it
	// stays true afterwards, so a refetch-on-focus of a genuinely empty collection
	// won't flip the empty state back to the spinner.
	if (data.length === 0 && !isFetchedAfterMount) {
		return <RecordLoading label="Loading collection…" />;
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Collection</h1>
					<p className="mt-0.5 text-sm text-muted-foreground">
						<span className="font-medium tabular-nums text-foreground">
							{formatMoney(totals.total, "USD")}
						</span>{" "}
						/ {totals.valued} {totals.valued === 1 ? "record" : "records"}
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
				<div className="flex w-full flex-wrap items-center gap-2 md:w-auto">
					<div className="relative w-full md:w-56">
						<Input
							ref={searchRef}
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter records…"
							className="w-full pr-9"
						/>
						{!filter && (
							<kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 select-none items-center rounded border bg-muted px-1.5 font-mono text-xs text-muted-foreground md:inline-flex border">
								/
							</kbd>
						)}
					</div>

					{/* Facet filters live in a popover so the header stays a single tidy row
					    on mobile. The trigger badges the active count; the panel holds the
					    tri-state segmented pairs + on/off flags, combined with AND. Each
					    pill shows how many records that option would leave, honouring the
					    other groups already picked. */}
					<Popover>
						<PopoverTrigger asChild>
							<Button
								variant="outline"
								className="flex-1 md:flex-none"
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
							className="w-[min(28rem,calc(100vw-2rem))] space-y-1"
						>
							{/* One labelled row per group: a fixed label column keeps the
							    segmented controls aligned in a tidy column instead of wrapping. */}
							{FACET_GROUPS.map((group) => (
								<div key={group.key} className="flex items-center gap-3">
									<span className="w-14 shrink-0 text-xs text-muted-foreground">
										{group.label}
									</span>
									<SegmentedFilter
										group={group}
										active={activeFacets}
										rows={data}
										duplicateIds={duplicateIds}
										onToggle={toggleFilter}
									/>
								</div>
							))}
							<div className="flex items-start gap-3 border-t pt-2">
								<span className="w-14 shrink-0 pt-1 text-xs text-muted-foreground">
									Flags
								</span>
								<div className="flex flex-wrap items-center gap-2">
									{FLAG_FACETS.map((flag) => {
										const isActive = activeFacets.includes(flag.token);
										const count = facetCount(
											data,
											activeFacets,
											flag,
											flag.token,
											duplicateIds,
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
								</div>
							</div>
							{activeFacets.length > 0 && (
								<div className="flex justify-end border-t pt-2">
									<button
										type="button"
										onClick={() => setFacets([])}
										className="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
									>
										Clear filters
									</button>
								</div>
							)}
						</PopoverContent>
					</Popover>

					{/* Split primary action: "Capture record" is the common path; the caret
					    tucks the rarer "Add manually" behind a dropdown. */}
					<div className="flex flex-1 md:flex-none">
						<Button asChild className="flex-1 rounded-r-none md:flex-none">
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
				<div className="flex min-h-14 sticky top-4 z-10 items-center gap-2 rounded-lg border border-sidebar-accent bg-sidebar/80 backdrop-blur-sm px-5 py-2">
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
							<div className="hidden items-center gap-2 md:flex">
								{bulkActions.map((action) => {
									const { label, destructive } = BULK_ACTIONS[action];
									return (
										<Button
											key={action}
											type="button"
											size="sm"
											variant={destructive ? "destructive" : "outline"}
											disabled={bulkMutation.isPending}
											onClick={() => runBulkAction(action)}
										>
											{label}
										</Button>
									);
								})}
							</div>

							{/* Mobile: the same actions collapsed into a dropdown so the
							    toolbar stays on one row. */}
							<div className="md:hidden">
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
										{bulkActions.map((action) => (
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

			{/* Mobile: stacked cards (the wide table doesn't fit a phone). Rendered
			    only below md — see useIsDesktop — so we don't reconcile both layouts. */}
			{!isDesktop && (
				<ul className="space-y-2">
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
								<button
									type="button"
									aria-label="Quick view"
									onClick={() => setPreviewId(r.id)}
									className="shrink-0 rounded"
								>
									{thumb ? (
										<FadeImage
											src={`/api/photos/${thumb}`}
											alt=""
											loading="lazy"
											decoding="async"
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
											{r.status === "review" && !r.masterId ? (
												<UnmatchedBadge />
											) : (
												<StatusBadge status={r.status} />
											)}
											{duplicateIds.has(r.id) && <DuplicateBadge />}
											{r.professionalJobStatus === "failed" && (
												<GenerationFailedBadge />
											)}
											{r.professionalAlphaSource === "deterministic" && (
												<MatteFallbackBadge />
											)}
											{r.pitchforkScore != null && (
												<span className="text-xs text-muted-foreground tabular-nums">
													Pitchfork {r.pitchforkScore}
												</span>
											)}
											{r.professionalAlphaSource === "ai" &&
												r.professionalJobStatus === "failed" && (
													<MatteStaleBadge />
												)}
											<StatusError record={r} />
										</div>
									</div>
								</Link>
							</li>
						);
					})}
					{visibleRowCount === 0 && (
						<li className="rounded-lg border border-dashed border-border px-3 py-10 text-center">
							<EmptyState filtered={isFiltered} />
						</li>
					)}
				</ul>
			)}

			{/* Desktop: the full sortable table. Rendered only at md+ — see useIsDesktop. */}
			{isDesktop && (
				<table className="w-full border-collapse text-sm">
					<thead>
						{table.getHeaderGroups().map((hg) => (
							<tr key={hg.id} className="border-b text-left">
								{hg.headers.map((header) => (
									<th
										key={header.id}
										className={cn(
											// The select column drops its padding and goes `relative` so the
											// checkbox label can absolutely fill it; a fixed width keeps the
											// padding-free cell from collapsing.
											header.column.id === "select"
												? "relative w-12 p-0 font-medium"
												: "px-3 py-2 font-medium",
											header.column.columnDef.meta?.className,
										)}
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
							<AdminTableRow
								key={row.id}
								row={row}
								isSelected={row.getIsSelected()}
								onNavigate={navigateToRecord}
							/>
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
			)}

			{/* Quick-view drawer — the same panel the public site uses, in admin mode
			    so it surfaces the private valuation + pinned-release status. */}
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
