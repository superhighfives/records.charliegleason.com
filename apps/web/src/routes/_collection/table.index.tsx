import { createFileRoute } from "@tanstack/react-router";

import { publicRecordsQueryOptions } from "#/lib/records-queries";

/**
 * The collection as a table — the plain layout, kept alongside the 3D wall
 * at `/`. No component: the `_collection` layout renders it.
 */
export const Route = createFileRoute("/_collection/table/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
});
