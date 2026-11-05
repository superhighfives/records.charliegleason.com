import { createFileRoute } from "@tanstack/react-router";

import { publicRecordsQueryOptions } from "#/lib/records-queries";

/**
 * The collection as the plain grid — the simple layout, kept alongside the
 * 3D wall at `/`. No component: the `_collection` layout renders it.
 */
export const Route = createFileRoute("/_collection/grid/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
});
