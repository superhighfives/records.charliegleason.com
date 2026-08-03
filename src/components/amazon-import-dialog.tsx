import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RedoIcon, UploadIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useDiscogsSearch } from "#/components/discogs-search-field";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { Record } from "#/db/schema";
import {
	type AmazonItem,
	matchAmazonToRecord,
	parseAmazonOrderHistory,
} from "#/lib/amazon-csv";
import {
	assignArgs,
	type Candidate,
	candidateDetail,
	candidateLabel,
	groupCandidates,
} from "#/lib/discogs-candidate";
import { assignRecordIdentity } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

// Resolving an ASIN runs a web search, so work through matched purchases a batch
// at a time (queued one lookup at a time, like the bulk assign dialog) rather than
// firing a hundred expensive lookups at once.
const BATCH_SIZE = 10;

/** An Amazon purchase paired with the unmatched record it likely belongs to. */
interface ImportRow {
	item: AmazonItem;
	record: Record;
}

/**
 * Import an Amazon "Request My Data" order-history export and use it to match the
 * collection's unmatched records to Discogs. Parses the CSV client-side, fuzzily
 * lines each music purchase up with an unmatched record (by title), then resolves
 * each purchase's ASIN through the shared unified search (web-search identify →
 * barcode/keyword match) so a pressing can be picked and assigned. Only ever
 * assigns to records you already have — it never creates records from Amazon data.
 */
export function AmazonImportDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const queryClient = useQueryClient();
	const recordsQuery = useQuery(recordsQueryOptions);
	const unmatched = useMemo(
		() => (recordsQuery.data ?? []).filter((r) => r.masterId == null),
		[recordsQuery.data],
	);

	const fileRef = useRef<HTMLInputElement>(null);
	// Parsed purchases: matched (paired with a record) and the count that matched no
	// unmatched record, kept only to report "N couldn't be matched to a record".
	const [rows, setRows] = useState<Array<ImportRow> | null>(null);
	const [unmatchedCount, setUnmatchedCount] = useState(0);
	const [parseError, setParseError] = useState<string | null>(null);
	const [selections, setSelections] = useState<Map<string, Candidate>>(
		new Map(),
	);
	const [skipped, setSkipped] = useState<Set<string>>(new Set());
	const [autoSearchedAsins, setAutoSearchedAsins] = useState<Set<string>>(
		new Set(),
	);

	useEffect(() => {
		if (open) {
			setRows(null);
			setUnmatchedCount(0);
			setParseError(null);
			setSelections(new Map());
			setSkipped(new Set());
			setAutoSearchedAsins(new Set());
		}
	}, [open]);

	async function handleFile(file: File | undefined) {
		if (!file) return;
		setParseError(null);
		const text = await file.text();
		const items = parseAmazonOrderHistory(text);
		if (items.length === 0) {
			setParseError(
				"No music orders found in that file. Make sure it's the Retail.OrderHistory.csv from Amazon's data export.",
			);
			setRows([]);
			return;
		}
		const matched: Array<ImportRow> = [];
		let noMatch = 0;
		for (const item of items) {
			const id = matchAmazonToRecord(item, unmatched);
			const record =
				id != null ? unmatched.find((r) => r.id === id) : undefined;
			if (record) matched.push({ item, record });
			else noMatch++;
		}
		setRows(matched);
		setUnmatchedCount(noMatch);
	}

	const remaining = (rows ?? []).filter((r) => !skipped.has(r.item.asin));
	const batch = remaining.slice(0, BATCH_SIZE);
	const done = rows != null && rows.length > 0 && remaining.length === 0;
	const autoAsin = batch.find((r) => !autoSearchedAsins.has(r.item.asin))?.item
		.asin;

	const saveBatch = useMutation({
		mutationFn: async () => {
			const toAssign = batch.filter((r) => selections.has(r.item.asin));
			const outcomes = await Promise.allSettled(
				toAssign.map((r) => {
					// biome-ignore lint/style/noNonNullAssertion: filtered by selections.has above
					const candidate = selections.get(r.item.asin)!;
					return assignRecordIdentity({
						data: assignArgs(candidate, r.record.id),
					});
				}),
			);
			return toAssign.map((r, i) => ({
				asin: r.item.asin,
				outcome: outcomes[i],
			}));
		},
		onSuccess: async (results) => {
			await queryClient.invalidateQueries({
				queryKey: recordsQueryOptions.queryKey,
			});
			const failed = results.filter(
				(r) => r.outcome.status === "rejected",
			).length;
			if (failed > 0) {
				toast.error(
					failed === 1
						? "One record couldn't be saved. Try again."
						: `${failed} records couldn't be saved. Try again.`,
				);
			}
			// Saved rows drop out of the pool; failures stay selected for a retry.
			const failedAsins = new Set(
				results
					.filter((r) => r.outcome.status === "rejected")
					.map((r) => r.asin),
			);
			const savedAsins = results
				.filter((r) => r.outcome.status !== "rejected")
				.map((r) => r.asin);
			setSkipped((s) => {
				const next = new Set(s);
				for (const asin of savedAsins) next.add(asin);
				return next;
			});
			setSelections((s) => {
				const next = new Map(s);
				for (const asin of s.keys()) {
					if (!failedAsins.has(asin)) next.delete(asin);
				}
				return next;
			});
		},
		onError: () => toast.error("Couldn't save this batch."),
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Import from Amazon</DialogTitle>
					<DialogDescription>
						Upload your Amazon order history (Retail.OrderHistory.csv from{" "}
						<span className="font-medium">Request My Data</span>) to match
						unmatched records to Discogs using what you bought.
					</DialogDescription>
				</DialogHeader>

				{rows == null ? (
					<div className="space-y-3">
						<Button
							type="button"
							variant="outline"
							onClick={() => fileRef.current?.click()}
						>
							<UploadIcon className="size-4" />
							Choose CSV
						</Button>
						<input
							ref={fileRef}
							type="file"
							accept=".csv,text/csv"
							className="hidden"
							onChange={(e) => handleFile(e.target.files?.[0])}
						/>
						<p className="text-xs text-muted-foreground">
							Get the file from Amazon → Account → Request Your Information →{" "}
							<span className="font-medium">Your Orders</span>. Only music
							purchases are read, and nothing is uploaded anywhere — the file is
							parsed here in your browser.
						</p>
						{parseError && <p className="text-xs text-red-600">{parseError}</p>}
					</div>
				) : done ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						All caught up — nothing left to match in this import.
					</p>
				) : (
					<>
						<p className="text-xs text-muted-foreground">
							{remaining.length} matched to an unmatched record.
							{unmatchedCount > 0 &&
								` ${unmatchedCount} purchase${unmatchedCount === 1 ? "" : "s"} couldn't be paired with a record — match those by hand.`}
						</p>
						{rows.length === 0 ? (
							<p className="py-4 text-center text-sm text-muted-foreground">
								None of your Amazon music purchases matched an unmatched record.
							</p>
						) : (
							<ul className="divide-y rounded-md border">
								{batch.map((row) => (
									<AmazonImportRow
										key={row.item.asin}
										row={row}
										autoSearch={row.item.asin === autoAsin}
										onAutoSearchDone={() =>
											setAutoSearchedAsins((s) => new Set(s).add(row.item.asin))
										}
										selected={selections.get(row.item.asin)}
										onSelect={(candidate) =>
											setSelections((s) => {
												const next = new Map(s);
												if (candidate) next.set(row.item.asin, candidate);
												else next.delete(row.item.asin);
												return next;
											})
										}
										onSkip={() =>
											setSkipped((s) => new Set(s).add(row.item.asin))
										}
									/>
								))}
							</ul>
						)}
					</>
				)}

				{rows != null && rows.length > 0 && !done && (
					<DialogFooter>
						<Button
							type="button"
							onClick={() => saveBatch.mutate()}
							disabled={selections.size === 0 || saveBatch.isPending}
						>
							{saveBatch.isPending ? "Saving…" : "Save"}
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}

function AmazonImportRow({
	row,
	autoSearch,
	onAutoSearchDone,
	selected,
	onSelect,
	onSkip,
}: {
	row: ImportRow;
	autoSearch: boolean;
	onAutoSearchDone: () => void;
	selected: Candidate | undefined;
	onSelect: (candidate: Candidate | undefined) => void;
	onSkip: () => void;
}) {
	// Seed the search with the ASIN so it resolves via the web-search identify path.
	const search = useDiscogsSearch({
		initialInput: row.item.asin,
		// Pre-select the preferred pick — the exact barcode-matched release when
		// Amazon gave one, else the top album (master) as a placeholder to refine.
		onResults: (cands, preferredKey) =>
			onSelect(
				preferredKey ? cands.find((c) => c.key === preferredKey) : undefined,
			),
		onSettled: () => {
			if (autoSearch) onAutoSearchDone();
		},
	});

	const hasAutoSearched = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire once when this row's turn comes up
	useEffect(() => {
		if (autoSearch && !hasAutoSearched.current) {
			hasAutoSearched.current = true;
			search.run();
		}
	}, [autoSearch]);

	const busy = search.pending || search.browserPending;
	const { masters, releases } = groupCandidates(search.results ?? []);

	return (
		<li className="flex flex-col gap-1 p-2">
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium" title={row.item.title}>
						{row.record.artist} — {row.record.title}
					</p>
					<p
						className="truncate text-xs text-muted-foreground"
						title={row.item.title}
					>
						Amazon: {row.item.title}
					</p>
				</div>
				<Select
					value={selected?.key}
					onValueChange={(value) =>
						onSelect(search.results?.find((c) => c.key === value))
					}
					disabled={busy || !search.results || search.results.length === 0}
				>
					<SelectTrigger
						className="w-0 min-w-0 flex-1 overflow-hidden"
						size="sm"
					>
						<SelectValue
							placeholder={
								busy
									? "Resolving…"
									: search.results && search.results.length === 0
										? "No match found"
										: "Choose a pressing"
							}
						>
							{selected && (
								<span
									className="min-w-0 truncate"
									title={candidateLabel(selected)}
								>
									{candidateLabel(selected)}
								</span>
							)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent position="popper" className="max-w-[min(32rem,90vw)]">
						{masters.length > 0 && (
							<SelectGroup>
								<SelectLabel>Albums</SelectLabel>
								{masters.map((c) => (
									<CandidateOption key={c.key} candidate={c} />
								))}
							</SelectGroup>
						)}
						{releases.length > 0 && (
							<SelectGroup>
								<SelectLabel>Pressings</SelectLabel>
								{releases.map((c) => (
									<CandidateOption key={c.key} candidate={c} />
								))}
							</SelectGroup>
						)}
					</SelectContent>
				</Select>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label="Skip"
					onClick={onSkip}
				>
					<RedoIcon className="size-4" />
				</Button>
			</div>

			{search.notice && (
				<p className="text-xs text-muted-foreground">{search.notice}</p>
			)}
			{search.error && (
				<div className="flex items-center gap-2" role="alert">
					<p className="text-xs text-red-600">{search.error.message}</p>
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={search.browserPending}
						onClick={() => search.runBrowserFallback()}
					>
						{search.browserPending ? "Searching…" : "Search from browser"}
					</Button>
				</div>
			)}
		</li>
	);
}

/** One master/release option: the headline + a muted distinguishing detail line. */
function CandidateOption({ candidate }: { candidate: Candidate }) {
	const label = candidateLabel(candidate);
	const detail = candidateDetail(candidate);
	return (
		<SelectItem
			value={candidate.key}
			title={detail ? `${label} — ${detail}` : label}
		>
			<span className="flex min-w-0 items-center gap-2">
				{candidate.data.thumb ? (
					<img
						src={candidate.data.thumb}
						alt=""
						className="size-6 shrink-0 rounded object-cover"
					/>
				) : (
					<div className="size-6 shrink-0 rounded bg-muted" />
				)}
				<span className="flex min-w-0 flex-col">
					<span className="min-w-0 truncate">{label}</span>
					{detail && (
						<span className="min-w-0 truncate text-xs text-muted-foreground">
							{detail}
						</span>
					)}
				</span>
			</span>
		</SelectItem>
	);
}
