import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { toPublicRecord } from "#/lib/records";

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
				// Public = published AND has an album (master) — mirrors listPublicRecords
				// so the JSON API never surfaces a record without an album identity.
				const rows = await db
					.select()
					.from(records)
					.where(
						and(eq(records.status, "complete"), isNotNull(records.masterId)),
					)
					.orderBy(desc(records.createdAt));

				// The iPhone capture, valuation fields, and the internal professional-
				// job bookkeeping are admin-only; never expose them publicly.
				const publicRows = rows.map(toPublicRecord);

				return json(
					{ records: publicRows, count: publicRows.length },
					{ headers: { "access-control-allow-origin": "*" } },
				);
			},
		},
	},
});
