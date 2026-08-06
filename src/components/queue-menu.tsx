import { useClerk } from "@clerk/clerk-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Disc, Loader2, OctagonX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import type { JobStep } from "#/db/schema";
import type { InFlightItem, QueueOutcome } from "#/lib/records";
import { failAllInFlight } from "#/lib/records";
import {
	inFlightQueryOptions,
	queueOutcomesQueryOptions,
} from "#/lib/records-queries";
import { cn } from "#/lib/utils";

/**
 * Numbered, human labels for the fine-grained `jobStep` the consumer records as it works.
 * Both pipelines read as "(n/4) …" on a fixed denominator; the conditional steps (web-search
 * escalation, deterministic matte fallback) reuse their parent step's number rather than
 * bumping the total, so the count never jumps around mid-run.
 */
const STEP_LABELS: Record<JobStep, string> = {
	// analyze — reading → matching (→ web-search) → scoring → artwork
	reading: "(1/4) Reading cover",
	matching: "(2/4) Matching on Discogs",
	"web-search": "(2/4) Searching the web",
	scoring: "(3/4) Scoring",
	artwork: "(4/4) Fetching artwork",
	// apply — reframe → enhance → matte-ai | matte-fallback → finishing
	reframe: "(1/4) Reframing sleeve",
	enhance: "(2/4) Enhancing",
	"matte-ai": "(3/4) Generating matte",
	"matte-fallback": "(3/4) Generating matte (fallback)",
	finishing: "(4/4) Finishing",
};

/**
 * The step label for a queued item: which stage of its pipeline it's actually in — waiting
 * in the queue vs actively running. A processing job that's recorded a fine-grained
 * `jobStep` shows that numbered sub-step ("(2/4) Enhancing"); the same row updates in place
 * as the step advances on the next poll. Without one — a queued job, a freshly re-enqueued
 * one, or a legacy row — it falls back to the coarse stage label. `active` is true once the
 * job is actually running (not just queued), so the menu accents the live step in the brand
 * colour and leaves a still-waiting one muted.
 */
function stepLabel(item: InFlightItem): { text: string; active: boolean } {
	// A recorded sub-step wins — the most specific, numbered label — but only while actually
	// running, so a stale marker on a queued/re-enqueued row can't read as live progress.
	if (item.step && item.state === "processing")
		return { text: STEP_LABELS[item.step], active: true };

	if (item.kind === "analyze") {
		return item.state === "processing"
			? { text: "Analyzing capture", active: true }
			: { text: "Queued to analyze", active: false };
	}
	if (item.kind === "amazon") {
		return { text: "Looking up pressing on Amazon", active: false };
	}
	if (item.kind === "audit") {
		return { text: "Scanning stored covers", active: true };
	}
	if (item.state !== "processing")
		return { text: "Queued to generate", active: false };
	if (item.stage === "cover")
		return { text: "(1/2) Generating photo", active: true };
	if (item.stage === "matte")
		return { text: "(2/2) Generating matte", active: true };
	return { text: "Generating photo", active: true };
}

/**
 * The label + colour for a finished row, keyed on its terminal outcome. A clean finish is
 * muted with no dot; a deterministic-matte fallback and a hard failure each get a coloured
 * status dot to the left (amber / red) so the outcome is legible at a glance, matching the
 * amber "Magic matte unavailable" / red "generation failed" states in the editor. `undefined`
 * (outcomes still loading, or an id not yet resolved) reads as a plain finish.
 */
function FinishedLabel({
	outcome,
}: {
	outcome: QueueOutcome["outcome"] | undefined;
}) {
	if (outcome === "failed") {
		return (
			<span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
				<span className="size-1.5 shrink-0 rounded-full bg-current" />
				Failed
			</span>
		);
	}
	if (outcome === "fallback") {
		return (
			<span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
				<span className="size-1.5 shrink-0 rounded-full bg-current" />
				Finished (no Magic matte)
			</span>
		);
	}
	return <span className="text-muted-foreground">Finished</span>;
}

/** A job that has left the in-flight set — kept around for the rest of the session. */
interface FinishedItem {
	id: number;
	artist: string;
	title: string;
	thumbKey: string | null;
}

/** Most recent finished jobs to keep — plenty for a capture session, bounded so it can't grow forever. */
const MAX_FINISHED = 20;
const STORAGE_KEY = "queue-finished-v1";

/** A finished entry needs at least an id + labels to render a usable row. */
function isFinishedItem(value: unknown): value is FinishedItem {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "number" &&
		typeof v.artist === "string" &&
		typeof v.title === "string" &&
		(typeof v.thumbKey === "string" || v.thumbKey === null)
	);
}

function loadFinished(): FinishedItem[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		// Don't trust the stored blob — a legacy/tampered value could be malformed or
		// oversized, and on a pure load (no live poll) it'd never get shape-checked or
		// sliced. Drop bad entries and clamp before it reaches the menu.
		return parsed.filter(isFinishedItem).slice(0, MAX_FINISHED);
	} catch {
		return [];
	}
}

/**
 * Track jobs after they finish. The in-flight query drops an item the instant its
 * background job ends, so on every poll we diff the live set against the previous
 * one: anything that was running last tick but isn't now gets recorded as finished
 * and kept (in `sessionStorage`, so it survives route changes and reloads) until
 * the session ends or the user clears it. An id that goes live again — a re-Apply —
 * leaves the finished list and shows as in-flight again.
 */
function useQueueHistory(live: Array<InFlightItem & { id: number }>) {
	// Start empty so the first client render matches the server's (no hydration
	// mismatch), then hydrate from sessionStorage once mounted.
	const [finished, setFinished] = useState<FinishedItem[]>([]);
	const prevLive = useRef<Map<number, InFlightItem>>(new Map());
	const firstPersist = useRef(true);

	useEffect(() => {
		const stored = loadFinished();
		if (stored.length > 0) setFinished(stored);
	}, []);

	useEffect(() => {
		const liveIds = new Set(live.map((i) => i.id));
		setFinished((current) => {
			const departed: FinishedItem[] = [];
			for (const [id, item] of prevLive.current) {
				if (!liveIds.has(id) && !current.some((f) => f.id === id)) {
					departed.push({
						id,
						artist: item.artist,
						title: item.title,
						thumbKey: item.thumbKey,
					});
				}
			}
			// Drop any finished entry that's live again (a re-Apply) so it moves back
			// up into the in-flight section rather than showing in both.
			const kept = current.filter((f) => !liveIds.has(f.id));
			prevLive.current = new Map(live.map((i) => [i.id, i]));
			if (departed.length === 0 && kept.length === current.length) {
				return current;
			}
			return [...departed, ...kept].slice(0, MAX_FINISHED);
		});
	}, [live]);

	useEffect(() => {
		// Skip the initial run so hydrating from storage can't immediately write the
		// empty starting state back over it.
		if (firstPersist.current) {
			firstPersist.current = false;
			return;
		}
		if (typeof window === "undefined") return;
		try {
			window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(finished));
		} catch {
			// A full/blocked sessionStorage just means history won't persist a reload.
		}
	}, [finished]);

	return { finished, clear: () => setFinished([]) };
}

/** A single record row in the menu, linking through to its editor. */
function QueueRow({
	id,
	artist,
	title,
	thumbKey,
	label,
	busy,
}: {
	/** Null for a job not tied to any one record (e.g. the audit sweep) — renders as a plain, non-navigable row. */
	id: number | null;
	artist: string;
	title: string;
	thumbKey: string | null;
	label: React.ReactNode;
	/** In-flight rows get a spinner fallback; finished rows a static one so they don't read as still-running. */
	busy: boolean;
}) {
	// A key can 404 — a finished row's frozen history key whose object a later re-Apply
	// deleted — so fall back to the icon instead of the browser's broken-image glyph.
	// Tracked by key (not a bool) so a changed thumbKey retries rather than staying failed.
	const [failedKey, setFailedKey] = useState<string | null>(null);
	const showImage = thumbKey != null && failedKey !== thumbKey;
	const content = (
		<>
			<span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
				{showImage ? (
					<img
						src={`/api/photos/${thumbKey}`}
						alt=""
						className="size-full object-cover"
						onError={() => setFailedKey(thumbKey)}
					/>
				) : busy ? (
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				) : (
					<Disc className="size-4 text-muted-foreground" />
				)}
			</span>
			<span className="flex min-w-0 flex-col">
				{/* Finished rows fade the title to muted too, matching their status text. */}
				<span
					className={cn(
						"truncate font-medium",
						!busy && "text-muted-foreground",
					)}
				>
					{title ? `${artist} — ${title}` : artist}
				</span>
				{/* Colour is set by the caller's node (active step = brand, else muted). */}
				<span className="text-xs">{label}</span>
			</span>
		</>
	);
	if (id == null) {
		return (
			<DropdownMenuItem
				disabled
				className="gap-3 opacity-100 data-[disabled]:opacity-100"
			>
				{content}
			</DropdownMenuItem>
		);
	}
	return (
		<DropdownMenuItem asChild>
			<Link
				to="/admin/records/$id"
				params={{ id: String(id) }}
				// Scroll-list rows read as a background highlight, not the global focus
				// ring, so hovering the long list stays calm — shadow-none cancels it.
				className="gap-3 focus-visible:shadow-none"
			>
				{content}
			</Link>
		</DropdownMenuItem>
	);
}

/**
 * Header dropdown listing everything currently in flight — captures being analysed and
 * Apply jobs generating a photo — plus jobs that finished earlier this session, so the
 * admin can kick off long jobs, walk away, and still jump back to any of them from here.
 * Polls via {@link inFlightQueryOptions}. The trigger hides entirely when there's nothing
 * running and no session history, so it's invisible at rest.
 */
/**
 * A write server function guarded by `authMiddleware` rejects with a 401/403 (message
 * "Unauthorized"/"Forbidden") when the request's session token is stale — which can happen
 * while the SPA stays mounted and the client-side `<SignedIn>` gate still reads as signed in.
 * Detect that so the queue can prompt a re-auth instead of showing a dead-end error.
 */
function isAuthError(error: unknown): boolean {
	if (!error) return false;
	const status =
		(error as { status?: number; statusCode?: number }).status ??
		(error as { statusCode?: number }).statusCode;
	if (status === 401 || status === 403) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /unauthor|forbidden/i.test(message);
}

export function QueueMenu() {
	const { data } = useQuery(inFlightQueryOptions);
	const live = data ?? [];
	// The audit sweep isn't a record — no thumbnail, no per-record outcome to show once
	// it finishes — so it's excluded from the finished-history diff entirely; it just
	// disappears from the live list when the sweep completes.
	const historyLive = live.filter(
		(item): item is InFlightItem & { id: number } => item.id != null,
	);
	const { finished, clear } = useQueueHistory(historyLive);
	const queryClient = useQueryClient();

	// The audit sweep updates records' matte-audit badges as it goes, but nothing else
	// polls the plain records list while it runs — invalidate once the sweep's item
	// disappears from `live` so flagged rows show up without a manual refresh.
	const wasAuditing = useRef(false);
	useEffect(() => {
		const auditing = live.some((item) => item.kind === "audit");
		if (wasAuditing.current && !auditing) {
			queryClient.invalidateQueries({ queryKey: ["records"] });
		}
		wasAuditing.current = auditing;
	}, [live, queryClient]);

	// Resolve each finished row's terminal outcome (failed / deterministic-matte fallback /
	// ok) — the in-flight diff loses it when the item departs, so we look it up by id here.
	const { data: outcomes } = useQuery(
		queueOutcomesQueryOptions(finished.map((f) => f.id)),
	);
	const outcomeById = new Map((outcomes ?? []).map((o) => [o.id, o.outcome]));
	// The record's *current* cover, so a finished row shows a live thumbnail rather than the
	// key frozen into session history — which a later re-Apply can delete out from under it.
	const coverKeyById = new Map((outcomes ?? []).map((o) => [o.id, o.coverKey]));

	// "Fail all" is a two-step action inside the menu (arm → confirm) rather than a native
	// dialog, so it doesn't fight the dropdown's own open/close. Reset the armed state
	// whenever the menu closes so it never reopens already-confirming.
	const { redirectToSignIn } = useClerk();
	const [confirmingFailAll, setConfirmingFailAll] = useState(false);
	const failAll = useMutation({
		mutationFn: () => failAllInFlight(),
		onSuccess: async ({ count }) => {
			toast.success(
				count === 0
					? "Nothing was still running."
					: `Stopped ${count} job${count === 1 ? "" : "s"}.`,
			);
		},
		onError: (error) => {
			// A stale session token makes the write 401 while the shell still reads as
			// signed in — offer a re-auth instead of a dead-end error.
			if (isAuthError(error)) {
				toast.error("Your session expired — sign in again to stop the jobs.", {
					action: {
						label: "Sign in",
						onClick: () => redirectToSignIn(),
					},
				});
				return;
			}
			// Otherwise surface the actual reason instead of a blanket message: the server
			// may have stopped the jobs even when the client saw a failure (a healthy
			// handler behind a flaky response), and a bare "Couldn't stop" hides whether it
			// was a network blip or a real server error.
			const reason = error instanceof Error ? error.message : String(error);
			toast.error(`Couldn't stop the running jobs: ${reason}`);
		},
		// Reconcile with server truth on both paths: the confirm row closes and the
		// in-flight list re-fetches whether the call reported success or failure, so a
		// silent server-side success can't leave the UI stuck showing stopped jobs.
		// (Fuzzy-matches the in-flight key too, so the list clears on the next tick.)
		onSettled: async () => {
			setConfirmingFailAll(false);
			await queryClient.invalidateQueries({ queryKey: ["records"] });
		},
	});

	if (live.length === 0 && finished.length === 0) return null;

	const busy = live.length > 0;
	const count = busy ? live.length : finished.length;

	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (!open) setConfirmingFailAll(false);
			}}
		>
			<DropdownMenuTrigger
				aria-label={
					busy
						? `${live.length} job${live.length === 1 ? "" : "s"} in flight`
						: `${finished.length} finished job${finished.length === 1 ? "" : "s"}`
				}
				className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				{busy ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<Check className="size-4" />
				)}
				<span className="tabular-nums">{count}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72">
				{/* The list can get long (a whole capture session), so it scrolls; the
				    "Clear finished" action stays pinned below as a non-scrolling sibling. */}
				<div className="max-h-[400px] overflow-y-auto overflow-x-hidden">
					{live.map((item) => {
						const step = stepLabel(item);
						return (
							<QueueRow
								key={item.id ?? item.kind}
								id={item.id}
								artist={item.artist}
								title={item.title}
								thumbKey={item.thumbKey}
								label={
									<span
										className={
											step.active ? "text-brand" : "text-muted-foreground"
										}
									>
										{step.text}
									</span>
								}
								busy
							/>
						);
					})}
					{finished.length > 0 && (
						<>
							{busy && <DropdownMenuSeparator />}
							{finished.map((item) => {
								// Prefer the record's current cover once the outcomes query has
								// resolved it (present in the map — even as null); until then fall
								// back to the key frozen in session history.
								const current = coverKeyById.get(item.id);
								const thumbKey = coverKeyById.has(item.id)
									? current
									: item.thumbKey;
								return (
									<QueueRow
										key={item.id}
										id={item.id}
										artist={item.artist}
										title={item.title}
										thumbKey={thumbKey ?? null}
										label={<FinishedLabel outcome={outcomeById.get(item.id)} />}
										busy={false}
									/>
								);
							})}
						</>
					)}
				</div>
				{/* "Fail all" — stop everything in flight when the pipeline is thrashing.
				    Two-step so a stray click can't nuke a live capture session: the first
				    select arms it (keeping the menu open via preventDefault), the second
				    fires. Only shown while something is actually running. */}
				{busy && (
					<>
						<DropdownMenuSeparator />
						{confirmingFailAll ? (
							<div className="flex min-h-9 items-center justify-between gap-2 px-2 py-1.5 text-xs">
								<span className="text-muted-foreground">
									Stop {live.length} running job{live.length === 1 ? "" : "s"}?
								</span>
								<div className="flex items-center gap-1">
									<button
										type="button"
										onClick={() => setConfirmingFailAll(false)}
										className="rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
									>
										Cancel
									</button>
									<button
										type="button"
										disabled={failAll.isPending}
										onClick={() => failAll.mutate()}
										className="rounded px-2 py-1 font-medium text-red-600 hover:bg-accent disabled:opacity-60 dark:text-red-400"
									>
										{failAll.isPending ? "Stopping…" : "Stop all"}
									</button>
								</div>
							</div>
						) : (
							<DropdownMenuItem
								// Keep the menu open so the confirm step can replace this row.
								onSelect={(e) => {
									e.preventDefault();
									setConfirmingFailAll(true);
								}}
								className="min-h-9 justify-center gap-2 text-xs text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
							>
								<OctagonX className="size-3.5" />
								Fail all
							</DropdownMenuItem>
						)}
					</>
				)}
				{finished.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={() => clear()}
							className="min-h-9 justify-center text-xs text-muted-foreground"
						>
							Clear finished
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
