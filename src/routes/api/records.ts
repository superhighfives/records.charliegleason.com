import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { fetchPublicRecords } from "#/lib/records";

/**
 * Public, read-only JSON API for the collection.
 *
 * Consumed by charliegleason.com and the `ssh charliegleason.com` TUI. Reads are
 * public; writes happen through the Clerk-gated /admin server functions.
 */
export const Route = createFileRoute("/api/records")({
	server: {
		handlers: {
			GET: async () => {
				// Same query as listPublicRecords — excludes secondary copies and
				// includes each primary's linked-copies count.
				const publicRows = await fetchPublicRecords();

				return json(
					{ records: publicRows, count: publicRows.length },
					{ headers: { "access-control-allow-origin": "*" } },
				);
			},
		},
	},
});
