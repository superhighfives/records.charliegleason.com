import { queryOptions } from "@tanstack/react-query";

import { getRecord, listPublicRecords, listRecords } from "#/lib/records";

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
	});
