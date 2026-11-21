import type { Record } from "#/db/schema";

/**
 * A queued value fetch finishes or gives up well inside this window (three
 * retries with backoff), so an older queued marker is a lost message.
 */
export const VALUE_QUEUE_WINDOW_MS = 60 * 60 * 1000;

/** Whether a value fetch for `r` is queued and still in its window. */
export function isValueQueued(
	r: Pick<Record, "discogsValueQueuedAt">,
): boolean {
	return (
		r.discogsValueQueuedAt != null &&
		Date.now() - r.discogsValueQueuedAt.getTime() < VALUE_QUEUE_WINDOW_MS
	);
}

/**
 * A record whose Discogs identity is broken: it has a link (master and/or
 * release), but every link it has 404'd on the last health check (see
 * master-health.ts), so nothing live identifies it. A record with one live link
 * is still publishable and is not broken.
 */
export function hasBrokenLink(r: Record): boolean {
	const liveMaster = r.masterId != null && !r.masterMissing;
	const liveRelease = r.discogsId != null && !r.releaseMissing;
	return (
		(r.masterId != null || r.discogsId != null) && !liveMaster && !liveRelease
	);
}

/** A record with no Discogs identity at all: no album and no pressing. */
export function isUnmatched(r: Record): boolean {
	return r.masterId == null && r.discogsId == null;
}

export interface RecordAlertCounts {
	brokenLinks: number;
	unmatched: number;
	analysisFailed: number;
	imageFailed: number;
	/** An album is linked, but no pressing, so Discogs can't price it. */
	needsPressing: number;
	/** A pressing is pinned, but its value was never fetched or queued. */
	valuesToFetch: number;
}

/** What needs attention across the collection, for the header's alerts menu. */
export function countRecordAlerts(rows: readonly Record[]): RecordAlertCounts {
	const counts: RecordAlertCounts = {
		brokenLinks: 0,
		unmatched: 0,
		analysisFailed: 0,
		imageFailed: 0,
		needsPressing: 0,
		valuesToFetch: 0,
	};
	for (const r of rows) {
		if (hasBrokenLink(r)) counts.brokenLinks += 1;
		if (isUnmatched(r)) counts.unmatched += 1;
		if (r.status === "failed") counts.analysisFailed += 1;
		if (r.professionalJobStatus === "failed") counts.imageFailed += 1;
		if (r.masterId != null && r.discogsId == null) counts.needsPressing += 1;
		if (
			r.discogsId != null &&
			r.discogsValueFetchedAt == null &&
			!isValueQueued(r)
		) {
			counts.valuesToFetch += 1;
		}
	}
	return counts;
}
