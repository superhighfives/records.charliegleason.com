import { createFileRoute } from "@tanstack/react-router";

import { loadRecordRoute } from "#/lib/record-route";

/**
 * A public record's page on the wall: `/records/<id>-<title-slug>` (see
 * `loadRecordRoute`). No component: the `_collection` layout reads the id
 * from the route params and opens the drawer over the shared collection.
 */
export const Route = createFileRoute("/_collection/records/$id")({
	loader: ({ context, params }) =>
		loadRecordRoute(context.queryClient, params.id, "wall"),
});
