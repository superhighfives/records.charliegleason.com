import { createFileRoute, redirect } from "@tanstack/react-router";

import { parseRecordIdParam, recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

/**
 * A public record's page: `/records/<id>-<title-slug>`. The id is authoritative;
 * the slug is decorative, so the loader canonicalises a missing/stale slug and
 * sends an unknown id back to the grid. No component: the `_collection` layout
 * reads the id from the route params and opens the drawer over the shared grid.
 */
export const Route = createFileRoute("/_collection/records/$id")({
	loader: async ({ context, params }) => {
		const data = await context.queryClient.ensureQueryData(
			publicRecordsQueryOptions,
		);
		const id = parseRecordIdParam(params.id);
		const record = id == null ? undefined : data.find((r) => r.id === id);
		if (!record) throw redirect({ to: "/" });
		const canonical = recordIdParam(record);
		if (params.id !== canonical)
			throw redirect({ to: "/records/$id", params: { id: canonical } });
		return { id: record.id };
	},
});
