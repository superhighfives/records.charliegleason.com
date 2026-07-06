import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { toPublicRecord } from "#/lib/cover";

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
				const db = getDb(env.DB);
				const rows = await db
					.select()
					.from(records)
					.where(eq(records.status, "complete"))
					.orderBy(desc(records.createdAt));

				// The iPhone capture is admin-only, and the professional-job error /
				// prediction id are internal; never expose them publicly.
				const publicRows = rows.map(toPublicRecord);

				return json(
					{ records: publicRows, count: publicRows.length },
					{ headers: { "access-control-allow-origin": "*" } },
				);
			},
		},
	},
});
