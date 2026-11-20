import { createFileRoute } from "@tanstack/react-router";

import { loadRecordRoute } from "#/lib/record-route";

/**
 * A public record's page on the table: `/table/records/<id>-<title-slug>`
 * (see `loadRecordRoute`). No component: the `_collection` layout opens the
 * drawer over the table.
 */
export const Route = createFileRoute("/_collection/table/records/$id")({
	loader: ({ context, params }) =>
		loadRecordRoute(context.queryClient, params.id, "table"),
});
