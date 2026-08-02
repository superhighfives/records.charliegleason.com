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
	searchMastersFromBrowser,
	searchReleasesFromBrowser,
} from "#/lib/discogs-browser";
import type {
	DiscogsCandidate,
	DiscogsMasterCandidate,
} from "#/lib/discogs-shared";
import {
	assignRecordIdentity,
	searchDiscogs,
	searchDiscogsMasters,
} from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

// How many unmatched records to work through per pass — small enough that a
// stretch of good matches doesn't feel endless, and the batch clears fast
// enough that the "next 10" swap reads as steady progress.
const BATCH_SIZE = 10;

type Query = { artist: string; title: string };

/**
 * A pickable identity for a record — either a Discogs master (album) or a release
 * (specific pressing). The row searches both, because a master search alone misses
 * albums Discogs files under an odd master title (e.g. "Led Zeppelin IV", whose
 * canonical master is untitled), whereas the pressings surface reliably. `key` is a
 * kind-prefixed unique id so masters and releases can't collide in the picker.
 */
type Candidate =
	| { kind: "master"; key: string; data: DiscogsMasterCandidate }
	| { kind: "release"; key: string; data: DiscogsCandidate };

const toMaster = (m: DiscogsMasterCandidate): Candidate => ({
	kind: "master",
	key: `m:${m.masterId}`,
	data: m,
});
const toRelease = (r: DiscogsCandidate): Candidate => ({
	kind: "release",
	key: `r:${r.discogsId}`,
	data: r,
});

/** "Artist — Title (Year)" headline, shared by masters and releases. */
function candidateLabel(c: Candidate): string {
	const { artist, title, year } = c.data;
	return `${artist} — ${title}${year ? ` (${year})` : ""}`;
}

/**
 * The distinguishing detail line — what tells two same-titled options apart. For a
 * master that's mostly the genre; for a release it's the pressing specifics
 * (format, size, country, label, catalog number) that make one pressing not
 * another. Empty parts are dropped.
 */
function candidateDetail(c: Candidate): string {
	if (c.kind === "master") {
		return [c.data.genre].filter(Boolean).join(" · ");
	}
	const r = c.data;
	return [r.type ?? r.format, r.size, r.country, r.label, r.catno]
		.filter(Boolean)
		.join(" · ");
}

/** An error's message, or a fallback when it isn't an `Error`. */
function errText(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/**
 * The save-payload for a pick — a master sets the album link; a release sets the
 * pressing link *and* its parent master (a null `masterId` clears it, for a
 * standalone release). Album-level metadata rides along either way.
 */
function assignArgs(c: Candidate, id: number) {
	const { artist, title, year, genre } = c.data;
	const meta = { artist, title, year, genre };
	if (c.kind === "master") {
		return {
			id,
			masterId: c.data.masterId,
			masterUrl: c.data.masterUrl,
			...meta,
		};
	}
	return {
		id,
		masterId: c.data.masterId,
		masterUrl: c.data.masterUrl,
		discogsId: c.data.discogsId,
		discogsUrl: c.data.discogsUrl,
		...meta,
	};
}

/**
 * Bulk identity picker for records still missing an album/release (`mode="assign"`,
 * the "Assign masters" button) or whose Discogs link broke (`mode="fix"`, the red
 * banner's Fix button). Works through the list in batches of {@link BATCH_SIZE}:
 * rows auto-search Discogs one at a time (queued, to avoid a burst of concurrent
 * requests) — masters *and* releases — and offer the matches grouped in a dropdown,
 * or the row can be skipped. Picks are staged locally and only persisted on Save,
 * which assigns the whole batch and slides the next batch in.
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

/**
 * Fetch masters + releases for a query, tag each with its kind, and merge. If one
 * search fails but the other succeeds we keep what we got; only a total failure
 * throws (so the row surfaces the browser-IP fallback).
 */
async function searchBoth(
	q: Query,
	masters: (q: Query) => Promise<Array<DiscogsMasterCandidate>>,
	releases: (q: Query) => Promise<Array<DiscogsCandidate>>,
): Promise<Array<Candidate>> {
	const [m, r] = await Promise.allSettled([masters(q), releases(q)]);
	if (m.status === "rejected" && r.status === "rejected") throw m.reason;
	return [
		...(m.status === "fulfilled" ? m.value.map(toMaster) : []),
		...(r.status === "fulfilled" ? r.value.map(toRelease) : []),
	];
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
	const [mode, setMode] = useState<"select" | "edit">("select");
	const [query, setQuery] = useState<Query>({
		artist: record.artist,
		title: record.title,
	});
	const [draft, setDraft] = useState<Query>(query);
	const [results, setResults] = useState<Array<Candidate> | null>(null);

	const search = useMutation({
		mutationFn: (q: Query) =>
			searchBoth(
				q,
				(p) =>
					searchDiscogsMasters({
						data: {
							artist: p.artist,
							title: p.title,
							country: "",
							year: "",
							q: "",
						},
					}),
				(p) =>
					searchDiscogs({
						data: {
							artist: p.artist,
							title: p.title,
							country: "",
							year: "",
							q: "",
						},
					}),
			),
		onSuccess: (candidates) => {
			setResults(candidates);
			onSelect(undefined);
		},
		onSettled: () => {
			if (autoSearch) onAutoSearchDone();
		},
	});
	// Same clean-IP fallback as the editor's pickers — the Worker's shared egress
	// IP is what Discogs actually rate-limits, so re-run both from the browser.
	const browserSearch = useMutation({
		mutationFn: (q: Query) =>
			searchBoth(
				q,
				(p) => searchMastersFromBrowser(p),
				(p) =>
					searchReleasesFromBrowser({
						artist: p.artist,
						title: p.title,
						country: "",
						year: "",
						q: "",
					}),
			),
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
	const masters = results?.filter((c) => c.kind === "master") ?? [];
	const releases = results?.filter((c) => c.kind === "release") ?? [];

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
							value={selected?.key}
							onValueChange={(value) =>
								onSelect(results?.find((c) => c.key === value))
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
