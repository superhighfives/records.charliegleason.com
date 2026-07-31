import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { listPublicRecords } from "#/lib/records";

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
				// Delegate to the homepage server fn — one source of truth for the public
				// query (published + has-album, secondary copies excluded, copies count
				// annotated), so the JSON API can never drift from what the site shows.
				const publicRows = await listPublicRecords();

				return json(
					{ records: publicRows, count: publicRows.length },
					{ headers: { "access-control-allow-origin": "*" } },
				);
			},
		},
	},
});
