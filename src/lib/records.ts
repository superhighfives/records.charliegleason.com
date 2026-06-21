import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { authMiddleware } from "#/lib/auth";
import { recordInputSchema } from "#/lib/record-schema";

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

export const createRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => recordInputSchema.parse(data))
	.handler(({ data }) =>
		Sentry.startSpan({ name: "createRecord" }, async () => {
			const db = getDb(env.DB);
			const [row] = await db
				.insert(records)
				.values({ ...data, source: "manual" })
				.returning();
			return row;
		}),
	);

export const updateRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((input: { id: number; data: unknown }) => ({
		id: input.id,
		data: recordInputSchema.parse(input.data),
	}))
	.handler(({ data: { id, data } }) =>
		Sentry.startSpan({ name: "updateRecord" }, async () => {
			const db = getDb(env.DB);
			const [row] = await db
				.update(records)
				.set({ ...data, updatedAt: new Date() })
				.where(eq(records.id, id))
				.returning();
			return row ?? null;
		}),
	);

export const deleteRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "deleteRecord" }, async () => {
			const db = getDb(env.DB);
			await db.delete(records).where(eq(records.id, id));
			return { id };
		}),
	);
