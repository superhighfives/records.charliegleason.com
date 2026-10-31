import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { parseRecordIdParam, recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

/**
 * The loader shared by a record's page on the wall (`/records/<id>-<slug>`)
 * and on the grid (`/grid/records/<id>-<slug>`). The id is authoritative; the
 * slug is decorative, so a missing/stale slug is canonicalised and an unknown
 * id goes back to that layout's collection.
 */
export async function loadRecordRoute(
	queryClient: QueryClient,
	param: string,
	layout: "wall" | "grid",
) {
	const data = await queryClient.ensureQueryData(publicRecordsQueryOptions);
	const id = parseRecordIdParam(param);
	const record = id == null ? undefined : data.find((r) => r.id === id);
	if (!record) throw redirect({ to: layout === "grid" ? "/grid" : "/" });
	const canonical = recordIdParam(record);
	if (param !== canonical) {
		throw redirect({
			to: layout === "grid" ? "/grid/records/$id" : "/records/$id",
			params: { id: canonical },
		});
	}
	return { id: record.id };
}
