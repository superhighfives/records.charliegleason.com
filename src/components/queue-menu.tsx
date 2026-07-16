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
 * waiting in the queue vs actively running. (The generate phase runs the enhance and
 * matte in parallel, so there's no finer reframe→enhance→matte sequence to show.)
 */
function stepLabel(item: InFlightItem): string {
	if (item.kind === "analyze") {
		return item.state === "processing"
			? "Analyzing capture"
			: "Queued to analyze";
	}
	return item.state === "processing"
		? "Generating photo"
		: "Queued to generate";
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

function loadFinished(): FinishedItem[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as FinishedItem[]) : [];
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
					<span className="text-xs text-muted-foreground">{label}</span>
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
				{live.map((item) => (
					<QueueRow
						key={item.id}
						id={item.id}
						artist={item.artist}
						title={item.title}
						thumbKey={item.thumbKey}
						label={stepLabel(item)}
						busy
					/>
				))}
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
								label="Finished — tap to view"
								busy={false}
							/>
						))}
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
