import { queryOptions } from "@tanstack/react-query";

import { getRecord, listRecords } from "#/lib/records";

/** TanStack Query options for the collection list + a single record. */
export const recordsQueryOptions = queryOptions({
	queryKey: ["records"] as const,
	queryFn: () => listRecords(),
});

export const recordQueryOptions = (id: number) =>
	queryOptions({
		queryKey: ["records", id] as const,
		queryFn: () => getRecord({ data: id }),
	});
