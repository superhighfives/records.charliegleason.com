import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { authMiddleware } from "#/lib/auth";
import {
	getReleaseCandidate,
	getReleaseDetail,
	parseReleaseId,
	searchParamsSchema,
	searchReleases,
} from "#/lib/discogs";
import { base64ToBytes, stripDataUrl } from "#/lib/image-data";
import {
	sourceCoverFromDiscogs,
	storeCapturePhoto,
	storeUploadedCover,
} from "#/lib/images";
import {
	enqueueAnalyze,
	enqueueAnalyzeBatch,
	enqueueRefreshBatch,
	refreshRecordById,
} from "#/lib/queue";
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
	// This writes to R2/D1, so validate + normalize the payload before use.
	.validator((data: unknown) => {
		const d = (data ?? {}) as Record<string, unknown>;
		if (typeof d.imageBase64 !== "string" || d.imageBase64.length === 0) {
			throw new Error("imageBase64 must be a non-empty string");
		}
		const mediaType =
			typeof d.mediaType === "string" && d.mediaType.startsWith("image/")
				? d.mediaType
				: "image/jpeg";
		return {
			imageBase64: d.imageBase64,
			mediaType,
			context: typeof d.context === "string" ? d.context : undefined,
		};
	})
	.handler(({ data }) =>
		Sentry.startSpan({ name: "captureRecord" }, async () => {
			const db = getDb(env.DB);
			const bytes = base64ToBytes(stripDataUrl(data.imageBase64));

			// Canonicalise to a square webp via Cloudflare Images (falls back to the
			// raw bytes if Image Transformations are unavailable).
			const { key: capturePhotoKey } = await storeCapturePhoto(
				bytes,
				data.mediaType,
			);

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

			// Don't strand a `pending` row if the queue is unavailable — mark it
			// `failed` so the detail page can offer a manual retry instead.
			try {
				await enqueueAnalyze(row.id);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				const [failed] = await db
					.update(records)
					.set({
						status: "failed",
						error: `Could not queue analysis: ${detail}`,
						updatedAt: new Date(),
					})
					.where(eq(records.id, row.id))
					.returning();
				return failed ?? row;
			}

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
			coverImageKey?: string | null;
		}) => ({
			id: input.id,
			data: recordInputSchema.parse(input.data),
			discogsId: input.discogsId ?? null,
			discogsUrl: input.discogsUrl ?? null,
			// Only accept keys minted by the cover pipeline. Without this an override
			// could point the public cover at an admin-only `captures/...` object (or
			// any other R2 key) and leak it.
			coverImageKey:
				typeof input.coverImageKey === "string" &&
				input.coverImageKey.startsWith("covers/")
					? input.coverImageKey
					: null,
		}),
	)
	.handler(
		({ data: { id, data, discogsId, discogsUrl, coverImageKey: uploaded } }) =>
			Sentry.startSpan({ name: "publishRecord" }, async () => {
				const db = getDb(env.DB);
				const [current] = await db
					.select()
					.from(records)
					.where(eq(records.id, id))
					.limit(1);
				if (!current) return null;

				let coverImageKey = current.coverImageKey;
				let coverFetchFailed = false;
				if (uploaded) {
					// A user-uploaded cover always wins over the Discogs artwork.
					coverImageKey = uploaded;
				} else if (discogsId && discogsId !== current.discogsId) {
					// New match → re-source its cover. If that fails, clear the cover
					// rather than keep the previous release's artwork (which would now be
					// wrong). The failure is logged in the cover pipeline and signalled
					// back so the admin gets a toast and can retry or upload manually.
					coverImageKey = await sourceCoverFromDiscogs(discogsId);
					coverFetchFailed = !coverImageKey;
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
				return row ? { record: row, coverFetchFailed } : null;
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

/**
 * Re-pull a single record from its stored Discogs release id and update the
 * enrichment fields (year, label, genre, format, size, catno, country). Runs
 * synchronously so the detail page gets the updated row straight back. Returns
 * null if the record is gone or has no Discogs id to refresh from.
 */
export const refreshRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "refreshRecord" }, () => refreshRecordById(id)),
	);

/**
 * Bulk "Rescan all": enqueue a Discogs refresh for every record that has a
 * stored Discogs id. Runs through the queue so it respects Discogs' rate limit.
 * Returns how many refreshes were queued.
 */
export const rescanAllRecords = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(() =>
		Sentry.startSpan({ name: "rescanAllRecords" }, async () => {
			const db = getDb(env.DB);
			const rows = await db
				.select({ id: records.id })
				.from(records)
				.where(
					and(eq(records.status, "complete"), isNotNull(records.discogsId)),
				);
			// Batch the queue writes (the actual Discogs work happens in the consumer,
			// rate-limited there) so a big collection turns into a handful of sendBatch
			// calls rather than hundreds of individual sends against the subrequest cap.
			await enqueueRefreshBatch(rows.map(({ id }) => id));
			return { queued: rows.length };
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
	.validator((data: unknown) => searchParamsSchema.parse(data))
	.handler(({ data }) =>
		// Let Discogs failures (bad token, rate limit, 5xx) propagate to the client
		// so the review page can show *why* a search came back empty, rather than
		// silently degrading to "no results". Genuine zero-match still returns [].
		Sentry.startSpan({ name: "searchDiscogs" }, () => searchReleases(data)),
	);

/**
 * Resolve a pasted Discogs release URL (or bare id) into a single candidate, so
 * the review page can pick a specific pressing without searching. Returns null
 * for anything that isn't a resolvable release.
 */
export const lookupDiscogsRelease = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => {
		if (typeof data !== "string") {
			throw new Error("Expected a Discogs release URL or id");
		}
		return data;
	})
	.handler(({ data: input }) =>
		Sentry.startSpan({ name: "lookupDiscogsRelease" }, () => {
			const id = parseReleaseId(input);
			if (!id) return null;
			return getReleaseCandidate(id).catch(() => null);
		}),
	);

/**
 * Store a user-uploaded cover image (base64 data URL) in R2 and return its key,
 * so the review page can override the auto-sourced Discogs artwork on publish.
 */
export const uploadCover = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => {
		const d = (data ?? {}) as Record<string, unknown>;
		if (typeof d.imageBase64 !== "string" || d.imageBase64.length === 0) {
			throw new Error("imageBase64 must be a non-empty string");
		}
		return { imageBase64: d.imageBase64 };
	})
	.handler(({ data }) =>
		Sentry.startSpan({ name: "uploadCover" }, () =>
			storeUploadedCover(base64ToBytes(stripDataUrl(data.imageBase64))),
		),
	);

export const deleteRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "deleteRecord" }, async () => {
			const db = getDb(env.DB);
			await db.delete(records).where(eq(records.id, id));
			// Clear the dangling reference on any record flagged as a duplicate of
			// the one we just removed, so it stops showing the "Duplicate" badge.
			await db
				.update(records)
				.set({ duplicateOf: null, updatedAt: new Date() })
				.where(eq(records.duplicateOf, id));
			return { id };
		}),
	);

/** Validator shared by the bulk actions below: a plain list of record ids. */
const idList = (ids: number[]) => ids;

/**
 * D1 rejects a query with more than 100 bound parameters, so a bulk
 * `inArray(id, ids)` over a large selection has to be split. We chunk well under
 * 100 to leave headroom for the columns a companion `.set(...)` also binds.
 */
const D1_PARAM_CHUNK = 90;
function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/**
 * Bulk delete. Removes every selected record in one statement and clears the
 * `duplicateOf` back-references in a second, rather than issuing a request per
 * row from the client. Returns how many ids were targeted.
 */
export const deleteRecords = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "deleteRecords" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				await db.delete(records).where(inArray(records.id, batch));
				await db
					.update(records)
					.set({ duplicateOf: null, updatedAt: new Date() })
					.where(inArray(records.duplicateOf, batch));
			}
			return { count: ids.length };
		}),
	);

/**
 * Bulk retry. Resets the selected rows to `pending` in a single statement, then
 * fans the (cheap) queue writes out concurrently — the actual analysis happens
 * in the consumer. Returns how many rows were re-queued.
 */
export const retryRecords = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "retryRecords" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			const updated: number[] = [];
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.update(records)
					.set({ status: "pending", error: null, updatedAt: new Date() })
					.where(inArray(records.id, batch))
					.returning({ id: records.id });
				updated.push(...rows.map(({ id }) => id));
			}
			await enqueueAnalyzeBatch(updated);
			return { count: updated.length };
		}),
	);

/**
 * Bulk refresh. Enqueues a Discogs re-pull for each selected record that has a
 * stored Discogs id, through the queue so it respects Discogs' rate limit —
 * rather than firing N synchronous Discogs fetches in parallel from the request.
 * Returns how many refreshes were queued (records without a Discogs id are
 * silently skipped).
 */
export const refreshRecords = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "refreshRecords" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			const matched: number[] = [];
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.select({ id: records.id })
					.from(records)
					.where(and(inArray(records.id, batch), isNotNull(records.discogsId)));
				matched.push(...rows.map(({ id }) => id));
			}
			await enqueueRefreshBatch(matched);
			return { count: matched.length };
		}),
	);
