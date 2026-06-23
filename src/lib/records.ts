import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { authMiddleware } from "#/lib/auth";
import { getReleaseDetail, searchReleases } from "#/lib/discogs";
import { base64ToBytes, stripDataUrl } from "#/lib/image-data";
import { sourceCoverFromDiscogs } from "#/lib/images";
import { enqueueAnalyze } from "#/lib/queue";
import { recordCreateSchema, recordInputSchema } from "#/lib/record-schema";

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

/**
 * Public list for the homepage — only published (`complete`) records, and omits
 * the admin-only iPhone capture key. In-flight / failed captures stay private.
 */
export const listPublicRecords = createServerFn({ method: "GET" }).handler(() =>
	Sentry.startSpan({ name: "listPublicRecords" }, async () => {
		const db = getDb(env.DB);
		const rows = await db
			.select()
			.from(records)
			.where(eq(records.status, "complete"))
			.orderBy(desc(records.createdAt));
		return rows.map(({ capturePhotoKey: _omit, ...r }) => r);
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
	.validator((data: unknown) => recordCreateSchema.parse(data))
	.handler(({ data }) =>
		Sentry.startSpan({ name: "createRecord" }, async () => {
			const db = getDb(env.DB);
			const { source, coverImageKey: provided, ...rest } = data;

			// Display cover comes from Discogs (resized → R2), not the iPhone shot.
			let coverImageKey = provided ?? null;
			if (!coverImageKey && rest.discogsId) {
				coverImageKey = await sourceCoverFromDiscogs(rest.discogsId);
			}

			const [row] = await db
				.insert(records)
				.values({
					...rest,
					coverImageKey,
					source: source ?? "manual",
					// Manually entered / imported records are ready to show immediately.
					status: "complete",
				})
				.returning();
			return row;
		}),
	);

/**
 * Capture flow entry: store the iPhone photo, insert a `pending` row, and enqueue
 * it for background analysis. Returns the new row so the UI can jump straight to
 * its detail page and watch the AI work land.
 */
export const captureRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(
		(data: { imageBase64: string; mediaType: string; context?: string }) =>
			data,
	)
	.handler(({ data }) =>
		Sentry.startSpan({ name: "captureRecord" }, async () => {
			const db = getDb(env.DB);
			const mediaType = data.mediaType || "image/jpeg";
			const raw = stripDataUrl(data.imageBase64);

			const ext = mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
			const capturePhotoKey = `captures/${crypto.randomUUID()}.${ext}`;
			await env.PHOTOS.put(capturePhotoKey, base64ToBytes(raw), {
				httpMetadata: { contentType: mediaType },
			});

			const [row] = await db
				.insert(records)
				.values({
					artist: "",
					title: "",
					format: "LP",
					source: "photo",
					status: "pending",
					capturePhotoKey,
					captureContext: data.context?.trim() || null,
				})
				.returning();

			await enqueueAnalyze(row.id);
			return row;
		}),
	);

/**
 * Confirm a captured record: save the (possibly edited) fields, apply the chosen
 * Discogs release, and publish it (`complete`). Also used to save edits to an
 * already-published record. Re-sources the cover when the Discogs pick changes.
 */
export const publishRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(
		(input: {
			id: number;
			data: unknown;
			discogsId?: string | null;
			discogsUrl?: string | null;
		}) => ({
			id: input.id,
			data: recordInputSchema.parse(input.data),
			discogsId: input.discogsId ?? null,
			discogsUrl: input.discogsUrl ?? null,
		}),
	)
	.handler(({ data: { id, data, discogsId, discogsUrl } }) =>
		Sentry.startSpan({ name: "publishRecord" }, async () => {
			const db = getDb(env.DB);
			const [current] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!current) return null;

			let coverImageKey = current.coverImageKey;
			if (discogsId && discogsId !== current.discogsId) {
				coverImageKey =
					(await sourceCoverFromDiscogs(discogsId)) ?? coverImageKey;
			}

			const [row] = await db
				.update(records)
				.set({
					...data,
					discogsId,
					discogsUrl,
					coverImageKey,
					status: "complete",
					error: null,
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();
			return row ?? null;
		}),
	);

/** Re-run the background analysis for a failed (or any) captured record. */
export const reprocessRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "reprocessRecord" }, async () => {
			const db = getDb(env.DB);
			const [row] = await db
				.update(records)
				.set({ status: "pending", error: null, updatedAt: new Date() })
				.where(eq(records.id, id))
				.returning();
			if (row) await enqueueAnalyze(id);
			return row ?? null;
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

/** Full Discogs release details for the expanded (accordion) candidate view. */
export const getDiscogsRelease = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator((id: string) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "getDiscogsRelease" }, () =>
			getReleaseDetail(id).catch(() => null),
		),
	);

/** Manual Discogs search for the review page's pick-list / "wrong match" fallback. */
export const searchDiscogs = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((q: { artist: string; title: string }) => q)
	.handler(({ data }) =>
		Sentry.startSpan({ name: "searchDiscogs" }, () =>
			searchReleases(data.artist, data.title).catch(() => []),
		),
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
