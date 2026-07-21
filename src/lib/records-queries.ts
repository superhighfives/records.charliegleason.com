import { queryOptions } from "@tanstack/react-query";

import {
	getRecord,
	listInFlight,
	listPublicRecords,
	listQueueOutcomes,
	listRecords,
} from "#/lib/records";

/** TanStack Query options for the collection list + a single record. */
export const recordsQueryOptions = queryOptions({
	queryKey: ["records"] as const,
	queryFn: () => listRecords(),
});

/** Public homepage list (no admin-only capture key). */
export const publicRecordsQueryOptions = queryOptions({
	queryKey: ["records", "public"] as const,
	queryFn: () => listPublicRecords(),
});

export const recordQueryOptions = (id: number) =>
	queryOptions({
		queryKey: ["records", id] as const,
		queryFn: () => getRecord({ data: id }),
		// While a background job is running on this record (analysis or an Apply photo
		// generation), poll so the editor reflects the result — e.g. the freshly
		// generated matte + cover — without a manual refresh. Idle otherwise.
		refetchInterval: (query) => {
			const r = query.state.data;
			const busy =
				r?.status === "pending" ||
				r?.status === "processing" ||
				r?.professionalJobStatus === "queued" ||
				r?.professionalJobStatus === "processing";
			return busy ? 4000 : false;
		},
	});

/**
 * Everything currently in flight, for the admin header's queue dropdown. Polls every few
 * seconds *only while something is actually in flight* — an empty queue has nothing to
 * watch for, so polling it forever (which it used to, every 4s round the clock, even
 * backgrounded) was pure noise. When the queue empties the poll stops; it re-arms on its
 * own the moment a job appears, because every enqueue path (capture / Apply / bulk
 * actions) invalidates the `["records"]` tree — which fuzzy-matches this key — and
 * `refetchOnWindowFocus` (on by default) refetches when the user returns to the tab,
 * covering a job started in another tab.
 */
export const inFlightQueryOptions = queryOptions({
	queryKey: ["records", "in-flight"] as const,
	queryFn: () => listInFlight(),
	refetchInterval: (query) => {
		const items = query.state.data;
		return items && items.length > 0 ? 4000 : false;
	},
	// While jobs ARE in flight, keep polling even when the tab is backgrounded — the point
	// of the queue is to kick off work and walk away, so it's current the moment you look
	// back. (No-op once the queue empties, since the interval above is then false.)
	refetchIntervalInBackground: true,
});

/**
 * Terminal outcomes (failed / deterministic-matte fallback / ok) for the header queue's
 * finished rows, keyed on the exact id set so it refetches whenever an item joins or leaves
 * the client's session history. A finished item's outcome is stable — a retry moves it back
 * into the in-flight set, out of this list — so there's no interval; one fetch per id-set
 * change is enough. The sorted key keeps a re-ordered-but-identical set from refetching.
 */
export const queueOutcomesQueryOptions = (ids: number[]) =>
	queryOptions({
		queryKey: [
			"records",
			"queue-outcomes",
			[...ids].sort((a, b) => a - b),
		] as const,
		queryFn: () => listQueueOutcomes({ data: ids }),
		enabled: ids.length > 0,
	});
