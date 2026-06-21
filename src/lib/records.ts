import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";

/**
 * Server-side data access for the records collection.
 *
 * These run only on the server (Cloudflare Worker), so they can reach the `DB`
 * D1 binding via `cloudflare:workers`. Each is wrapped in a Sentry span per the
 * project convention (see `.cursorrules`).
 */

export const listRecords = createServerFn({ method: "GET" }).handler(() =>
	Sentry.startSpan({ name: "listRecords" }, async () => {
		const db = getDb(env.DB);
		return db.select().from(records).orderBy(desc(records.createdAt));
	}),
);

export const getRecord = createServerFn({ method: "GET" })
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "getRecord" }, async () => {
			const db = getDb(env.DB);
			const [row] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			return row ?? null;
		}),
	);
