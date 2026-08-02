import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PencilIcon, RedoIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
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

type Query = { artist: string; title: string };

/** An error's message, or a fallback when it isn't an `Error`. */
function errText(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/**
 * Bulk "assign the album (master)" flow for records still missing one. Works
 * through the unmatched list in batches of {@link BATCH_SIZE}: rows auto-search
 * Discogs one at a time (queued, to avoid a burst of concurrent requests) and
 * offer the matches in a dropdown, or the row can be skipped. Picks are staged
 * locally and only persisted when Save is pressed, which assigns the whole
 * batch and slides the next batch in.
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
	const queryClient = useQueryClient();

	// Skipped rows are session-only — they drop out of the current pass but
	// aren't persisted, so reopening the dialog offers them again.
	const [skipped, setSkipped] = useState<Set<number>>(new Set());
	const [selections, setSelections] = useState<
		Map<number, DiscogsMasterCandidate>
	>(new Map());
	// Auto-search walks the batch one row at a time — each row runs its search
	// and reports back before the next one starts, rather than firing all ten
	// at once and inviting a Discogs 429.
	const [autoSearchedIds, setAutoSearchedIds] = useState<Set<number>>(
		new Set(),
	);
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

	const saveBatch = useMutation({
		mutationFn: async () => {
			const toAssign = batch.filter((r) => selections.has(r.id));
			const outcomes = await Promise.allSettled(
				toAssign.map((r) => {
					// biome-ignore lint/style/noNonNullAssertion: filtered by selections.has above
					const candidate = selections.get(r.id)!;
					return assignRecordMaster({
						data: {
							id: r.id,
							masterId: candidate.masterId,
							masterUrl: candidate.masterUrl,
							// Sync the row's album-level fields to the picked master so the
							// record's identity matches what was linked (analysis-guessed
							// artist/title/year/genre otherwise stick around and read as a
							// mismatch in the editor).
							artist: candidate.artist,
							title: candidate.title,
							year: candidate.year,
							genre: candidate.genre,
						},
					});
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
					<DialogTitle>Assign masters</DialogTitle>
					<DialogDescription>
						Pick each record's album match, or skip it for now.{" "}
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
	selected: DiscogsMasterCandidate | undefined;
	autoSearch: boolean;
	onAutoSearchDone: () => void;
	onSelect: (candidate: DiscogsMasterCandidate | undefined) => void;
	onSkip: () => void;
}) {
	const [mode, setMode] = useState<"select" | "edit">("select");
	const [query, setQuery] = useState<Query>({
		artist: record.artist,
		title: record.title,
	});
	const [draft, setDraft] = useState<Query>(query);
	const [results, setResults] = useState<Array<DiscogsMasterCandidate> | null>(
		null,
	);

	const search = useMutation({
		mutationFn: (q: Query) =>
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
			onSelect(undefined);
		},
		onSettled: () => {
			if (autoSearch) onAutoSearchDone();
		},
	});
	// Same clean-IP fallback as the editor's MasterPicker — the Worker's shared
	// egress IP is what Discogs actually rate-limits.
	const browserSearch = useMutation({
		mutationFn: (q: Query) => searchMastersFromBrowser(q),
		onSuccess: (candidates) => {
			setResults(candidates);
			onSelect(undefined);
		},
	});

	// It's this row's turn in the queue — fire the search itself, once, as
	// soon as the row mounts (there's no more manual "Search albums" button to
	// trigger it otherwise).
	const hasAutoSearched = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire once when this row's turn comes up, not on every query/search.mutate identity change
	useEffect(() => {
		if (autoSearch && !hasAutoSearched.current) {
			hasAutoSearched.current = true;
			search.mutate(query);
		}
	}, [autoSearch]);

	function runSearch(q: Query) {
		setQuery(q);
		setResults(null);
		search.mutate(q);
		setMode("select");
	}

	const coverKey = displayCoverKey(record, { includeCapture: true });
	const busy = search.isPending || browserSearch.isPending;

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

				{mode === "edit" ? (
					<>
						<div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
							<Input
								value={draft.artist}
								onChange={(e) =>
									setDraft((d) => ({ ...d, artist: e.target.value }))
								}
								placeholder="Artist"
								className="text-sm"
							/>
							<Input
								value={draft.title}
								onChange={(e) =>
									setDraft((d) => ({ ...d, title: e.target.value }))
								}
								placeholder="Title"
								className="text-sm"
							/>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Cancel"
							onClick={() => {
								setDraft(query);
								setMode("select");
							}}
						>
							<XIcon className="size-4" />
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label="Search Discogs"
							disabled={busy}
							onClick={() => runSearch(draft)}
						>
							<SearchIcon className="size-4" />
						</Button>
					</>
				) : (
					<>
						<Select
							value={selected ? String(selected.masterId) : undefined}
							onValueChange={(value) =>
								onSelect(results?.find((m) => String(m.masterId) === value))
							}
							disabled={busy || !results || results.length === 0}
						>
							<SelectTrigger
								className="w-0 min-w-0 flex-1 overflow-hidden"
								size="sm"
							>
								<SelectValue
									placeholder={
										busy
											? "Searching…"
											: results && results.length === 0
												? "No albums found"
												: "Choose an album"
									}
								>
									{selected && (
										<span
											className="min-w-0 truncate"
											title={`${selected.artist} — ${selected.title}${selected.year ? ` (${selected.year})` : ""}`}
										>
											{selected.artist} — {selected.title}
											{selected.year ? ` (${selected.year})` : ""}
										</span>
									)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent position="popper">
								{results?.map((m) => {
									const label = `${m.artist} — ${m.title}${m.year ? ` (${m.year})` : ""}`;
									return (
										<SelectItem key={m.masterId} value={String(m.masterId)}>
											<span className="flex min-w-0 items-center gap-2">
												{m.thumb ? (
													<img
														src={m.thumb}
														alt=""
														className="size-6 shrink-0 rounded object-cover"
													/>
												) : (
													<div className="size-6 shrink-0 rounded bg-muted" />
												)}
												<span className="min-w-0 truncate" title={label}>
													{label}
												</span>
											</span>
										</SelectItem>
									);
								})}
							</SelectContent>
						</Select>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label="Edit search"
							disabled={search.isPending}
							onClick={() => setMode("edit")}
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

			{search.isError && (
				<div className="flex items-center gap-2 pl-12" role="alert">
					<p className="text-xs text-red-600">
						{errText(search.error, "Search failed. Try again.")}
					</p>
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={browserSearch.isPending}
						onClick={() => browserSearch.mutate(query)}
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
		</li>
	);
}
