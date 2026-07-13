import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record as RecordRow, records } from "#/db/schema";
import { authMiddleware, getAdminSession } from "#/lib/auth";
import { chunk, D1_PARAM_CHUNK } from "#/lib/batching";
import {
	getReleaseCandidate,
	getReleaseDetail,
	getReleaseValue,
	MAX_PER_PAGE,
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
import { detectCaptureCorners, reframeFromCapture } from "#/lib/professional";
import {
	enqueueAnalyze,
	enqueueAnalyzeBatch,
	enqueueProfessional,
	enqueueProfessionalBatch,
	enqueueRefreshBatch,
	failStaleProfessional,
	fetchValueForRecord,
	refreshRecordById,
} from "#/lib/queue";
import { recordCreateSchema, recordInputSchema } from "#/lib/record-schema";
import type { ReframeParams } from "#/lib/reframe-params";
import {
	type NormalizedCorners,
	parseCorners,
	serializeCorners,
} from "#/lib/sleeve-corners";

/**
 * Server-side data access for the records collection.
 *
 * These run only on the server (Cloudflare Worker), so they can reach the `DB`
 * D1 binding via `cloudflare:workers`. Each is wrapped in a Sentry span per the
 * project convention (see `.cursorrules`).
 */

/**
 * Fields never sent to the public homepage / API. The iPhone capture is
 * admin-only, and so is everything to do with valuation — the collector's
 * manual/confirmed value and the Discogs price guess are private.
 */
const ADMIN_ONLY_FIELDS = [
	"capturePhotoKey",
	"confirmedRelease",
	"manualValue",
	"discogsValue",
	"discogsValueCurrency",
	"discogsValueJson",
	"discogsValueFetchedAt",
	// Internal professional-photo job bookkeeping — the last error, the admin-picked
	// sleeve corners and the reframe knob settings are never public.
	"professionalError",
	"sleeveCornersJson",
	"professionalParamsJson",
] as const;

/** The public shape of a record — the full row minus the admin-only fields. */
export type PublicRecord = Omit<RecordRow, (typeof ADMIN_ONLY_FIELDS)[number]>;

/** Drop the admin-only fields from a row so it's safe to return publicly. */
export function toPublicRecord(row: RecordRow): PublicRecord {
	const {
		capturePhotoKey: _capture,
		confirmedRelease: _confirmed,
		manualValue: _manual,
		discogsValue: _value,
		discogsValueCurrency: _currency,
		discogsValueJson: _valueJson,
		discogsValueFetchedAt: _fetchedAt,
		professionalError: _proError,
		sleeveCornersJson: _corners,
		professionalParamsJson: _proParams,
		...rest
	} = row;
	return {
		...rest,
		// Only expose the professional image once it's approved. `/api/photos/$`
		// serves any R2 key by passthrough, so leaking a `ready` (unreviewed) key
		// here would make the generation publicly fetchable and bypass the review gate.
		professionalImageKey:
			rest.professionalStatus === "approved" ? rest.professionalImageKey : null,
	};
}

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
		return rows.map(toPublicRecord);
	}),
);

export const getRecord = createServerFn({ method: "GET" })
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "getRecord" }, async () => {
			// Admin-only: this returns the full row (capture key, valuation, professional*
			// bookkeeping) and now also drives the watchdog write below, so it must not be
			// callable unauthenticated. Fail soft — it runs inside the /admin SSR loader,
			// where a thrown 401 would break the render rather than fall through to the
			// client-side signed-out redirect.
			if (!(await getAdminSession())) return null;

			const db = getDb(env.DB);
			const [row] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!row) return null;
			// Self-heal a professional-photo job wedged in pending/processing: since the
			// detail page polls this fn while a job is in flight, a stale one flips to
			// `failed` here and surfaces a "Try again" button on the next poll. The
			// watchdog is best-effort — never let its write break the read, so fall back
			// to the row as-is if it throws.
			try {
				return await failStaleProfessional(row);
			} catch {
				return row;
			}
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
					// Kick off the professional photo automatically on capture. Corners are
					// left unset so the queue seeds them by detecting the sleeve (the admin
					// then nudges the handles); a first pass is ready by the time it's reviewed.
					professionalStatus: "pending",
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

			// Best-effort: queue the background matte too. Independent of analysis — if it
			// can't enqueue, mark just the professional track failed (a manual button can
			// retry) rather than failing the whole capture.
			try {
				await enqueueProfessional(row.id);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				await db
					.update(records)
					.set({
						professionalStatus: "failed",
						professionalError: `Could not queue professional photo: ${detail}`,
						updatedAt: new Date(),
					})
					.where(eq(records.id, row.id))
					.catch(() => {});
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
 * (Re-)generate the professional photo for a captured record using its stored (or
 * full-frame default) corners. Marks it `pending` and enqueues the `professional` queue
 * mode; the detail page polls itself to `ready`. Queued (not inline) so it shares one
 * path with auto-on-capture and the bulk action, and doesn't block the request — the
 * reframe itself is free (pure pixel math, no external call). Returns the updated row,
 * or null if the record is gone. Throws if there's no capture to work from so the UI can
 * say why. Interactive corner edits + knob re-tweaks go through {@link reframeRecord}.
 */
export const generateProfessional = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "generateProfessional" }, async () => {
			const db = getDb(env.DB);
			const [record] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!record) return null;
			if (!record.capturePhotoKey) {
				throw new Error("This record has no capture photo to work from.");
			}
			const [row] = await db
				.update(records)
				.set({
					professionalStatus: "pending",
					professionalError: null,
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();
			await enqueueProfessional(id);
			return row ?? null;
		}),
	);

/**
 * Detect the sleeve's corners in a record's capture on demand — the corner editor's
 * "Detect corners" button. Runs the lightweight, free detector server-side and returns the
 * suggested corners for the admin to review before applying (or null if it can't find the
 * sleeve — e.g. a low-contrast cover). Does not persist anything; the follow-up Apply does.
 */
export const detectCorners = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "detectCorners" }, async () => {
			const db = getDb(env.DB);
			const [record] = await db
				.select({ capturePhotoKey: records.capturePhotoKey })
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!record?.capturePhotoKey) {
				throw new Error("This record has no capture photo to detect.");
			}
			return { corners: await detectCaptureCorners(record.capturePhotoKey) };
		}),
	);

/**
 * The FREE interactive reframe — the corner editor and the tone/margin knobs both call
 * this. Perspective-warps the real capture using the given (or stored) sleeve `corners`,
 * crops/squares/tones it, and stores the result, synchronously: no queue, so the admin
 * gets the updated image back in one request. Persists the corners in `sleeveCornersJson`
 * and the knobs in `professionalParamsJson` so they seed the next edit. Requires a capture
 * to warp — throws if there's none. Returns the updated row, or null if the record's gone.
 */
export const reframeRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(
		(input: {
			id: number;
			corners?: NormalizedCorners;
			params?: ReframeParams;
		}) => ({
			id: input.id,
			corners: input.corners,
			params: input.params ?? {},
		}),
	)
	.handler(({ data: { id, corners, params } }) =>
		Sentry.startSpan({ name: "reframeRecord" }, async () => {
			const db = getDb(env.DB);
			const [record] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!record) return null;
			if (!record.capturePhotoKey) {
				throw new Error("This record has no capture photo to reframe.");
			}
			// Use the edited corners if supplied, else whatever's stored (or the
			// full-frame default for a record that's never been cropped).
			const effectiveCorners =
				corners ?? parseCorners(record.sleeveCornersJson);
			const { key } = await reframeFromCapture(
				record.capturePhotoKey,
				effectiveCorners,
				params,
			);
			const [row] = await db
				.update(records)
				.set({
					sleeveCornersJson: serializeCorners(effectiveCorners),
					professionalImageKey: key,
					professionalParamsJson: JSON.stringify(params),
					// An interactive reframe always produces a reviewable image; keep an
					// already-approved photo live so a quick tweak goes straight out.
					professionalStatus:
						record.professionalStatus === "approved" ? "approved" : "ready",
					professionalError: null,
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();
			// Bin the superseded professional image so re-tweaks don't accumulate
			// orphaned objects in R2. Best-effort — the row already points at the new
			// key, so a failed cleanup just leaves one stale object, never a broken ref.
			const stale = record.professionalImageKey;
			if (stale && stale !== key) {
				await env.PHOTOS.delete(stale).catch(() => {});
			}
			return row ?? null;
		}),
	);

/**
 * Approve (promote) or unapprove the generated professional photo. Only
 * `approved` makes it the displayed cover (see displayCoverKey); unapproving
 * drops it back to `ready` — kept in R2, just not shown — so the site falls back
 * to the Discogs cover. No-op (returns null) if nothing's been generated yet.
 */
export const setProfessionalApproved = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((input: { id: number; approved: boolean }) => ({
		id: input.id,
		approved: Boolean(input.approved),
	}))
	.handler(({ data: { id, approved } }) =>
		Sentry.startSpan({ name: "setProfessionalApproved" }, async () => {
			const db = getDb(env.DB);
			const [record] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!record?.professionalImageKey) return null;
			const [row] = await db
				.update(records)
				.set({
					professionalStatus: approved ? "approved" : "ready",
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();
			return row ?? null;
		}),
	);

/**
 * Fetch just the Discogs value estimate for a single record (seller price
 * suggestions, falling back to the lowest listing) and store it. Runs
 * synchronously so the detail page gets the updated row straight back. Returns
 * null if the record is gone or has no Discogs id to value.
 */
export const fetchRecordValue = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "fetchRecordValue" }, () =>
			fetchValueForRecord(id),
		),
	);

/**
 * Estimate a value for a Discogs release id without touching any record. Lets the
 * admin preview pricing for a picked-but-unpublished edition inline before
 * committing to it. Returns null when Discogs yields no usable figure; genuine
 * failures (rate limit, auth, network) propagate so the client can surface them.
 */
export const previewReleaseValue = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((discogsId: string) => discogsId)
	.handler(({ data: discogsId }) =>
		Sentry.startSpan({ name: "previewReleaseValue" }, () =>
			getReleaseValue(discogsId),
		),
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
		// Return a full page of pressings (not the automated 5-hit shortlist) so the
		// review page can list them in a scrollable pick-list.
		Sentry.startSpan({ name: "searchDiscogs" }, () =>
			searchReleases(data, MAX_PER_PAGE),
		),
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
			// Read the record's R2 photo keys before dropping the row so we can
			// clean up the objects too — otherwise the capture, cover and pro
			// images (all in the PHOTOS bucket) would be orphaned forever.
			const [row] = await db
				.select({
					capturePhotoKey: records.capturePhotoKey,
					coverImageKey: records.coverImageKey,
					professionalImageKey: records.professionalImageKey,
				})
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			// Delete the R2 objects before dropping the row: if this throws
			// (transient R2 error), the row — and its keys — survive for a retry
			// rather than being orphaned with no way to recover them.
			if (row) {
				const keys = [
					row.capturePhotoKey,
					row.coverImageKey,
					row.professionalImageKey,
				].filter((key): key is string => Boolean(key));
				if (keys.length > 0) await env.PHOTOS.delete(keys);
			}
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
			// One timestamp for the whole action so every row touched by this bulk
			// delete shares an `updatedAt`, regardless of how it chunks.
			const now = new Date();
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				await db.delete(records).where(inArray(records.id, batch));
				await db
					.update(records)
					.set({ duplicateOf: null, updatedAt: now })
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
			// Single retry timestamp shared across chunks, so callers reading
			// `updatedAt` as "when this batch was retried" get one consistent value.
			const now = new Date();
			const updated: number[] = [];
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.update(records)
					.set({ status: "pending", error: null, updatedAt: now })
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

/**
 * Bulk professional photos. Marks every selected record that has a capture photo
 * `pending` and enqueues the Replicate work through the queue (rate-limited by
 * its concurrency cap) rather than firing N synchronous generations. Records
 * without a capture to work from are silently skipped. Returns how many were
 * queued.
 */
export const generateProfessionalPhotos = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "generateProfessionalPhotos" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			const now = new Date();
			const queued: number[] = [];
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.update(records)
					.set({
						professionalStatus: "pending",
						professionalError: null,
						updatedAt: now,
					})
					.where(
						and(inArray(records.id, batch), isNotNull(records.capturePhotoKey)),
					)
					.returning({ id: records.id });
				queued.push(...rows.map(({ id }) => id));
			}
			await enqueueProfessionalBatch(queued);
			return { count: queued.length };
		}),
	);
