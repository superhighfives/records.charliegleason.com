import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Disc, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import type { InFlightItem } from "#/lib/records";
import { inFlightQueryOptions } from "#/lib/records-queries";

/**
 * The step label for a queued item: which stage of its pipeline it's actually in —
 * waiting in the queue vs actively running. The generate pipeline runs in two sequential
 * stages (cover, then matte), so a processing job shows which one it's on as "(1/2)" /
 * "(2/2)"; the same row updates in place as `stage` advances on the next poll. Legacy
 * rows with no recorded stage fall back to the plain "Generating photo". `active` is true
 * once the job is actually running (not just queued), so the menu can accent the live
 * step in the brand colour and leave a still-waiting one muted.
 */
function stepLabel(item: InFlightItem): { text: string; active: boolean } {
	if (item.kind === "analyze") {
		return item.state === "processing"
			? { text: "Analyzing capture", active: true }
			: { text: "Queued to analyze", active: false };
	}
	if (item.state !== "processing")
		return { text: "Queued to generate", active: false };
	if (item.stage === "cover")
		return { text: "(1/2) Generating photo", active: true };
	if (item.stage === "matte")
		return { text: "(2/2) Finishing photo", active: true };
	return { text: "Generating photo", active: true };
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
function useQueueHistory(live: InFlightItem[]) {
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
	id: number;
	artist: string;
	title: string;
	thumbKey: string | null;
	label: React.ReactNode;
	/** In-flight rows get a spinner fallback; finished rows a static one so they don't read as still-running. */
	busy: boolean;
}) {
	return (
		<DropdownMenuItem asChild>
			<Link
				to="/admin/records/$id"
				params={{ id: String(id) }}
				className="gap-3"
			>
				<span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
					{thumbKey ? (
						<img
							src={`/api/photos/${thumbKey}`}
							alt=""
							className="size-full object-cover"
						/>
					) : busy ? (
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					) : (
						<Disc className="size-4 text-muted-foreground" />
					)}
				</span>
				<span className="flex min-w-0 flex-col">
					<span className="truncate font-medium">
						{artist} — {title}
					</span>
					{/* Colour is set by the caller's node (active step = brand, else muted). */}
					<span className="text-xs">{label}</span>
				</span>
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
export function QueueMenu() {
	const { data } = useQuery(inFlightQueryOptions);
	const live = data ?? [];
	const { finished, clear } = useQueueHistory(live);

	if (live.length === 0 && finished.length === 0) return null;

	const busy = live.length > 0;
	const count = busy ? live.length : finished.length;

	return (
		<DropdownMenu>
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
								key={item.id}
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
							{finished.map((item) => (
								<QueueRow
									key={item.id}
									id={item.id}
									artist={item.artist}
									title={item.title}
									thumbKey={item.thumbKey}
									label={
										<span className="text-muted-foreground">
											Finished — tap to view
										</span>
									}
									busy={false}
								/>
							))}
						</>
					)}
				</div>
				{finished.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={() => clear()}
							className="justify-center text-xs text-muted-foreground"
						>
							Clear finished
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
