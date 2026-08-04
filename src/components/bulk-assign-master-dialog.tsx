import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	PencilIcon,
	RedoIcon,
	SearchIcon,
	WrenchIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { ImageZoom } from "#/components/ui/image-zoom";
import { Input } from "#/components/ui/input";
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
import { displayCoverKey } from "#/lib/cover";
import {
	assignArgs,
	type Candidate,
	candidateDetail,
	candidateLabel,
	groupCandidates,
} from "#/lib/discogs-candidate";
import { assignRecordIdentity } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

// How many unmatched records to work through per pass — small enough that a
// stretch of good matches doesn't feel endless, and the batch clears fast
// enough that the "next 10" swap reads as steady progress.
const BATCH_SIZE = 10;

/**
 * Bulk identity picker for records still missing an album/release (`mode="assign"`,
 * the "Assign masters" button) or whose Discogs link broke (`mode="fix"`, the red
 * banner's Fix button). Works through the list in batches of {@link BATCH_SIZE}:
 * rows auto-search Discogs one at a time (queued, to avoid a burst of concurrent
 * requests) — masters *and* releases — and offer the matches grouped in a dropdown,
 * or the row can be skipped. Each row's search is the shared unified field, so a
 * row can also be re-queried with a Discogs URL, an Amazon ASIN, or a barcode.
 * Picks are staged locally and only persisted on Save, which assigns the whole
 * batch and slides the next batch in.
 */
export function BulkAssignMasterDialog({
	open,
	onOpenChange,
	records,
	mode = "assign",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	records: Array<Record>;
	mode?: "assign" | "fix";
}) {
	const queryClient = useQueryClient();

	// Skipped rows are session-only — they drop out of the current pass but
	// aren't persisted, so reopening the dialog offers them again.
	const [skipped, setSkipped] = useState<Set<number>>(new Set());
	const [selections, setSelections] = useState<Map<number, Candidate>>(
		new Map(),
	);
	// Auto-search walks the batch one row at a time — each row runs its search
	// and reports back before the next one starts, rather than firing all ten
	// at once and inviting a Discogs 429.
	const [autoSearchedIds, setAutoSearchedIds] = useState<Set<number>>(
		new Set(),
	);
	// Reset-on-open, not a `key`-driven remount: the Dialog needs to stay mounted
	// through its own close animation, so swapping `key`s on `open` would tear the
	// content down (and its transition) the instant `open` flips to false, before
	// Radix gets to animate it out.
	useEffect(() => {
		if (open) {
			setSkipped(new Set());
			setSelections(new Map());
			setAutoSearchedIds(new Set());
		}
	}, [open]);

	const remaining = records.filter((r) => !skipped.has(r.id));
	const batch = remaining.slice(0, BATCH_SIZE);
	const done = records.length > 0 && remaining.length === 0;
	const autoSearchId = batch.find((r) => !autoSearchedIds.has(r.id))?.id;

	const noun = mode === "fix" ? "broken" : "unmatched";

	const saveBatch = useMutation({
		mutationFn: async () => {
			const toAssign = batch.filter((r) => selections.has(r.id));
			const outcomes = await Promise.allSettled(
				toAssign.map((r) => {
					// biome-ignore lint/style/noNonNullAssertion: filtered by selections.has above
					const candidate = selections.get(r.id)!;
					return assignRecordIdentity({ data: assignArgs(candidate, r.id) });
				}),
			);
			return toAssign.map((r, i) => ({ id: r.id, outcome: outcomes[i] }));
		},
		onSuccess: async (results) => {
			await queryClient.invalidateQueries({
				queryKey: recordsQueryOptions.queryKey,
			});
			const vanished = results.filter(
				(r) => r.outcome.status === "fulfilled" && r.outcome.value === null,
			).length;
			const failed = results.filter(
				(r) => r.outcome.status === "rejected",
			).length;
			if (vanished > 0) {
				toast.error(
					vanished === 1
						? "One record vanished before it could be saved."
						: `${vanished} records vanished before they could be saved.`,
				);
			}
			if (failed > 0) {
				toast.error(
					failed === 1
						? "One record couldn't be saved. Try again."
						: `${failed} records couldn't be saved. Try again.`,
				);
			}
			// Only the rows that actually saved (or vanished) leave the pool —
			// anything that errored stays selected so Save can be retried without
			// re-picking, and anything left without a pick stays put and
			// reappears in the next batch rather than being silently dropped.
			const failedIds = new Set(
				results.filter((r) => r.outcome.status === "rejected").map((r) => r.id),
			);
			setSelections((s) => {
				const next = new Map(s);
				for (const id of s.keys()) {
					if (!failedIds.has(id)) next.delete(id);
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
					<DialogTitle className="flex items-center gap-2">
						{mode === "fix" && (
							<WrenchIcon className="size-4 text-red-600 dark:text-red-400" />
						)}
						{mode === "fix" ? "Fix broken links" : "Assign masters"}
					</DialogTitle>
					<DialogDescription>
						{mode === "fix"
							? "Re-link each record to a current album or pressing."
							: "Pick each record's album or pressing, or skip it for now."}{" "}
						{remaining.length > 0 &&
							`${remaining.length} ${noun} ${remaining.length === 1 ? "record" : "records"} left.`}
					</DialogDescription>
				</DialogHeader>

				{done ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						{mode === "fix"
							? "All fixed — nothing left broken."
							: "All caught up — nothing left unmatched."}
					</p>
				) : (
					<ul className="divide-y rounded-md border">
						{batch.map((record) => (
							<BulkAssignRow
								key={record.id}
								record={record}
								selected={selections.get(record.id)}
								autoSearch={record.id === autoSearchId}
								onAutoSearchDone={() =>
									setAutoSearchedIds((s) => new Set(s).add(record.id))
								}
								onSelect={(candidate) =>
									setSelections((s) => {
										const next = new Map(s);
										if (candidate) next.set(record.id, candidate);
										else next.delete(record.id);
										return next;
									})
								}
								onSkip={() => {
									setSkipped((s) => new Set(s).add(record.id));
									setSelections((s) => {
										const next = new Map(s);
										next.delete(record.id);
										return next;
									});
								}}
							/>
						))}
					</ul>
				)}

				{!done && (
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

function BulkAssignRow({
	record,
	selected,
	autoSearch,
	onAutoSearchDone,
	onSelect,
	onSkip,
}: {
	record: Record;
	selected: Candidate | undefined;
	autoSearch: boolean;
	onAutoSearchDone: () => void;
	onSelect: (candidate: Candidate | undefined) => void;
	onSkip: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const search = useDiscogsSearch({
		// Seed the single field with the record's own artist/title as the keyword
		// query; the auto-search below fires it. Editing replaces it wholesale, so a
		// row can be re-queried with a URL / ASIN / barcode too.
		initialInput: `${record.artist} ${record.title}`.trim(),
		// Pre-select the preferred pick — an exact release, else the top album as a
		// placeholder (refine the pressing later). Cleared when nothing's pickable.
		onResults: (cands, preferredKey) =>
			onSelect(
				preferredKey ? cands.find((c) => c.key === preferredKey) : undefined,
			),
		onSettled: () => {
			if (autoSearch) onAutoSearchDone();
		},
	});

	// It's this row's turn in the queue — fire the search itself, once, as soon as
	// the row's turn comes up (there's no manual "Search" button to trigger it).
	const hasAutoSearched = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire once when this row's turn comes up, not on every search identity change
	useEffect(() => {
		if (autoSearch && !hasAutoSearched.current) {
			hasAutoSearched.current = true;
			search.run();
		}
	}, [autoSearch]);

	const coverKey = displayCoverKey(record, { includeCapture: true });
	const busy = search.pending || search.browserPending;
	const { masters, releases } = groupCandidates(search.results ?? []);

	function submitEdit() {
		if (busy) return;
		search.run();
		setEditing(false);
	}

	return (
		<li className="flex flex-col gap-1 p-2">
			<div className="flex items-center gap-2">
				{coverKey ? (
					<ImageZoom
						src={`/api/photos/${coverKey}`}
						alt={`${record.artist} — ${record.title}`}
						className="size-10 shrink-0"
					/>
				) : (
					<div className="size-10 shrink-0 rounded-md border bg-muted" />
				)}

				{editing ? (
					<>
						<Input
							value={search.input}
							onChange={(e) => search.setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									submitEdit();
								}
							}}
							placeholder="Artist and title, Discogs link, barcode, or ASIN"
							className="min-w-0 flex-1 text-sm"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Cancel"
							onClick={() => setEditing(false)}
						>
							<XIcon className="size-4" />
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label="Search Discogs"
							disabled={busy}
							onClick={submitEdit}
						>
							<SearchIcon className="size-4" />
						</Button>
					</>
				) : (
					<>
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
											? "Searching…"
											: search.results && search.results.length === 0
												? "No matches found"
												: "Choose an album or pressing"
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
							<SelectContent
								position="popper"
								className="max-w-[min(32rem,90vw)]"
							>
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
							variant="outline"
							size="icon-sm"
							aria-label="Edit search"
							disabled={search.pending}
							onClick={() => setEditing(true)}
						>
							<PencilIcon className="size-4" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Skip"
							onClick={onSkip}
						>
							<RedoIcon className="size-4" />
						</Button>
					</>
				)}
			</div>

			{/* ASIN identification / empty-result notes surface here. */}
			{search.notice && (
				<p className="pl-12 text-xs text-muted-foreground">{search.notice}</p>
			)}

			{search.error && (
				<div className="flex items-center gap-2 pl-12" role="alert">
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

/**
 * One master/release option: thumb, the "Artist — Title (Year)" headline, and a
 * muted detail line ({@link candidateDetail}) that distinguishes same-titled hits.
 */
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
