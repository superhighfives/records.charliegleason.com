import { createFileRoute } from "@tanstack/react-router";

import { loadRecordRoute } from "#/lib/record-route";

/**
 * A public record's page on the grid: `/grid/records/<id>-<title-slug>` (see
 * `loadRecordRoute`). No component: the `_collection` layout opens the drawer
 * over the grid.
 */
export const Route = createFileRoute("/_collection/grid/records/$id")({
	loader: ({ context, params }) =>
		loadRecordRoute(context.queryClient, params.id, "grid"),
});
