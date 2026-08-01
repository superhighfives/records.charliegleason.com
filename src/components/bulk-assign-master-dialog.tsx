import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { ImageZoom } from "#/components/ui/image-zoom";
import { Input } from "#/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { Record } from "#/db/schema";
import { displayCoverKey } from "#/lib/cover";
import { searchMastersFromBrowser } from "#/lib/discogs-browser";
import type { DiscogsMasterCandidate } from "#/lib/discogs-shared";
import { assignRecordMaster, searchDiscogsMasters } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

// How many unmatched records to work through per pass — small enough that a
// stretch of good matches doesn't feel endless, and the batch clears fast
// enough that the "next 10" swap reads as steady progress.
const BATCH_SIZE = 10;

/** An error's message, or a fallback when it isn't an `Error`. */
function errText(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/** Case/whitespace-insensitive equality for auto-match comparisons. */
function looseEquals(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The single result to auto-assign, if any: either the only candidate
 * returned, or the one unambiguous exact artist+title match among several.
 * Anything less certain (no match, multiple exact matches) is left for the
 * user to pick by hand.
 */
function autoMatch(
	results: Array<DiscogsMasterCandidate>,
	artist: string,
	title: string,
): DiscogsMasterCandidate | null {
	if (results.length === 1) return results[0];
	const exact = results.filter(
		(m) => looseEquals(m.artist, artist) && looseEquals(m.title, title),
	);
	return exact.length === 1 ? exact[0] : null;
}

/**
 * Bulk "assign the album (master)" flow for records still missing one. Works
 * through the unmatched list in batches of {@link BATCH_SIZE}: search or skip
 * each row, and once every row in the batch is resolved the next batch takes
 * its place automatically (no manual "next" step). Reuses the same Discogs
 * master search as the single-record editor's `MasterPicker` — just a
 * compact, per-row popover instead of a full panel.
 */
export function BulkAssignMasterDialog({
	open,
	onOpenChange,
	records,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	records: Array<Record>;
}) {
	// Skipped rows are session-only — they drop out of the current pass but
	// aren't persisted, so reopening the dialog offers them again.
	const [skipped, setSkipped] = useState<Set<number>>(new Set());
	useEffect(() => {
		if (open) setSkipped(new Set());
	}, [open]);

	const remaining = records.filter((r) => !skipped.has(r.id));
	const batch = remaining.slice(0, BATCH_SIZE);
	const done = records.length > 0 && remaining.length === 0;

	// Auto-search walks the batch one row at a time — each row runs its search
	// and reports back before the next one starts, rather than firing all ten
	// at once and inviting a Discogs 429. A row leaving the batch (skipped or
	// auto-assigned) counts as "done" for free, since it just drops out of
	// `batch` below.
	const [autoSearchedIds, setAutoSearchedIds] = useState<Set<number>>(
		new Set(),
	);
	useEffect(() => {
		if (open) setAutoSearchedIds(new Set());
	}, [open]);
	const autoSearchId = batch.find((r) => !autoSearchedIds.has(r.id))?.id;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Assign masters</DialogTitle>
					<DialogDescription>
						Search Discogs for each record's album and pick a match, or skip it
						for now.{" "}
						{remaining.length > 0 &&
							`${remaining.length} unmatched ${remaining.length === 1 ? "record" : "records"} left.`}
					</DialogDescription>
				</DialogHeader>

				{done ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						All caught up — nothing left unmatched.
					</p>
				) : (
					<ul className="divide-y rounded-md border">
						{batch.map((record) => (
							<BulkAssignRow
								key={record.id}
								record={record}
								autoSearch={record.id === autoSearchId}
								onAutoSearchDone={() =>
									setAutoSearchedIds((s) => new Set(s).add(record.id))
								}
								onSkip={() => setSkipped((s) => new Set(s).add(record.id))}
							/>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}

function BulkAssignRow({
	record,
	autoSearch,
	onAutoSearchDone,
	onSkip,
}: {
	record: Record;
	autoSearch: boolean;
	onAutoSearchDone: () => void;
	onSkip: () => void;
}) {
	const queryClient = useQueryClient();
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [q, setQ] = useState({ artist: record.artist, title: record.title });
	const [results, setResults] = useState<Array<DiscogsMasterCandidate> | null>(
		null,
	);

	const search = useMutation({
		mutationFn: () =>
			searchDiscogsMasters({
				data: {
					artist: q.artist,
					title: q.title,
					country: "",
					year: "",
					q: "",
				},
			}),
		onSuccess: (candidates) => {
			setResults(candidates);
			const match = autoMatch(candidates, q.artist, q.title);
			if (match) assign.mutate(match);
		},
		onSettled: () => {
			if (autoSearch) onAutoSearchDone();
		},
	});
	// Same clean-IP fallback as the editor's MasterPicker — the Worker's shared
	// egress IP is what Discogs actually rate-limits.
	const browserSearch = useMutation({
		mutationFn: () =>
			searchMastersFromBrowser({ artist: q.artist, title: q.title }),
		onSuccess: setResults,
	});

	const assign = useMutation({
		mutationFn: (candidate: DiscogsMasterCandidate) =>
			assignRecordMaster({
				data: {
					id: record.id,
					masterId: candidate.masterId,
					masterUrl: candidate.masterUrl,
				},
			}),
		onSuccess: async (row) => {
			if (!row) {
				toast.error("Couldn't assign a master — the record vanished.");
				return;
			}
			await queryClient.invalidateQueries({
				queryKey: recordsQueryOptions.queryKey,
			});
			setPopoverOpen(false);
		},
		onError: () => toast.error("Couldn't assign a master."),
	});

	// It's this row's turn in the queue — fire the search itself, once. A
	// single/exact match assigns automatically (see `search`'s onSuccess);
	// anything more ambiguous just leaves `results` populated for the popover.
	const hasAutoSearched = useRef(false);
	useEffect(() => {
		if (autoSearch && !hasAutoSearched.current) {
			hasAutoSearched.current = true;
			search.mutate();
		}
	}, [autoSearch, search.mutate]);

	const coverKey = displayCoverKey(record, { includeCapture: true });

	return (
		<li className="flex items-center gap-2 p-2">
			{coverKey ? (
				<ImageZoom
					src={`/api/photos/${coverKey}`}
					alt={`${record.artist} — ${record.title}`}
					className="size-10 shrink-0"
				/>
			) : (
				<div className="size-10 shrink-0 rounded-md border bg-muted" />
			)}
			<div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
				<Input
					value={q.artist}
					onChange={(e) => setQ((s) => ({ ...s, artist: e.target.value }))}
					placeholder="Artist"
					className="text-sm"
				/>
				<Input
					value={q.title}
					onChange={(e) => setQ((s) => ({ ...s, title: e.target.value }))}
					placeholder="Title"
					className="text-sm"
				/>
			</div>

			<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						aria-label="Search Discogs"
						disabled={assign.isPending}
						onClick={() => {
							if (!results) search.mutate();
						}}
					>
						<SearchIcon className="size-4" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-80 space-y-2 p-2">
					<div className="flex justify-end">
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={search.isPending}
							onClick={() => search.mutate()}
						>
							{search.isPending ? "Searching…" : "Search albums"}
						</Button>
					</div>

					{search.isError && (
						<div className="space-y-1" role="alert">
							<p className="text-xs text-red-600">
								{errText(search.error, "Search failed. Try again.")}
							</p>
							<Button
								type="button"
								variant="outline"
								size="xs"
								disabled={browserSearch.isPending}
								onClick={() => browserSearch.mutate()}
							>
								{browserSearch.isPending ? "Searching…" : "Search from browser"}
							</Button>
							{browserSearch.isError && (
								<p className="text-xs text-red-600">
									{errText(
										browserSearch.error,
										"Browser search failed. Try again.",
									)}
								</p>
							)}
						</div>
					)}

					{results && results.length > 0 && (
						<ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
							{results.map((m) => (
								<li key={m.masterId}>
									<button
										type="button"
										disabled={assign.isPending}
										onClick={() => assign.mutate(m)}
										className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
									>
										{m.thumb ? (
											<img
												src={m.thumb}
												alt=""
												className="size-8 shrink-0 rounded object-cover"
											/>
										) : (
											<div className="size-8 shrink-0 rounded bg-muted" />
										)}
										<span className="min-w-0 flex-1 truncate">
											<span className="font-medium">{m.artist}</span> —{" "}
											{m.title}
											{m.year ? ` (${m.year})` : ""}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{search.isSuccess && results?.length === 0 && (
						<p className="text-xs text-muted-foreground" aria-live="polite">
							No albums found. Try adjusting the artist/title above.
						</p>
					)}
				</PopoverContent>
			</Popover>

			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={assign.isPending}
				onClick={onSkip}
			>
				Skip
			</Button>
		</li>
	);
}
