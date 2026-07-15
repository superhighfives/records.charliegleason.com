import { queryOptions } from "@tanstack/react-query";

import {
	getRecord,
	listInFlight,
	listPublicRecords,
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
 * Everything currently in flight, for the admin header's queue dropdown. Polls every
 * few seconds so the menu stays live; the poll is cheap (a single indexed query) and
 * this only mounts in the admin shell.
 */
export const inFlightQueryOptions = queryOptions({
	queryKey: ["records", "in-flight"] as const,
	queryFn: () => listInFlight(),
	refetchInterval: 4000,
	// Keep polling while the tab is backgrounded — the point of the queue is to kick off
	// jobs and walk away, so it should be current the moment the user looks back.
	refetchIntervalInBackground: true,
});
