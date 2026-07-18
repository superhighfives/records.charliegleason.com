import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record as RecordRow, records } from "#/db/schema";
import { authMiddleware, getAdminSession } from "#/lib/auth";
import { chunk, D1_PARAM_CHUNK } from "#/lib/batching";
import { displayCoverKey } from "#/lib/cover";
import {
	getMasterCandidate,
	getMasterVersions,
	getReleaseCandidate,
	getReleaseDetail,
	getReleaseValue,
	MAX_PER_PAGE,
	parseMasterId,
	parseReleaseId,
	searchMasters,
	searchParamsSchema,
	searchReleases,
} from "#/lib/discogs";
import { base64ToBytes, stripDataUrl } from "#/lib/image-data";
import {
	sourceCoverFromDiscogs,
	storeCapturePhoto,
	storeUploadedCover,
} from "#/lib/images";
import { generateMatteFromCapture } from "#/lib/matte";
import { detectCaptureCorners, professionalPipeline } from "#/lib/professional";
import {
	enqueueAnalyze,
	enqueueAnalyzeBatch,
	enqueueProfessional,
	enqueueRefreshBatch,
	fetchValueForRecord,
	refreshRecordById,
} from "#/lib/queue";
import { recordCreateSchema, recordInputSchema } from "#/lib/record-schema";
import {
	parseReframeParams,
	type ReframeParams,
	sanitizeReframeParams,
} from "#/lib/reframe-params";
import {
	type CornerBand,
	DEFAULT_BAND,
	parseCornerBand,
	parseNormalizedCornerBand,
	serializeCornerBand,
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
	"manualValue",
	"discogsValue",
	"discogsValueCurrency",
	"discogsValueJson",
	"discogsValueFetchedAt",
	// Internal professional-photo job bookkeeping — the last error, the admin-picked
	// sleeve corners, the reframe knob settings and the vestigial prediction id are
	// never public.
	"professionalError",
	"professionalEnhanced",
	"sleeveCornersJson",
	"professionalParamsJson",
	"professionalPredictionId",
	// Whether the matte came from the matting model or the deterministic path — internal.
	"professionalAlphaSource",
] as const;

/** The public shape of a record — the full row minus the admin-only fields. */
export type PublicRecord = Omit<RecordRow, (typeof ADMIN_ONLY_FIELDS)[number]>;

/** Drop the admin-only fields from a row so it's safe to return publicly. */
export function toPublicRecord(row: RecordRow): PublicRecord {
	const {
		capturePhotoKey: _capture,
		manualValue: _manual,
		discogsValue: _value,
		discogsValueCurrency: _currency,
		discogsValueJson: _valueJson,
		discogsValueFetchedAt: _fetchedAt,
		professionalError: _proError,
		professionalEnhanced: _proEnhanced,
		sleeveCornersJson: _corners,
		professionalParamsJson: _proParams,
		professionalPredictionId: _proPrediction,
		professionalAlphaSource: _alphaSource,
		...rest
	} = row;
	const approved = rest.professionalStatus === "approved";
	return {
		...rest,
		// Only expose the professional image + matte once approved. `/api/photos/$`
		// serves any R2 key by passthrough, so leaking a `ready` (unreviewed) key
		// here would make the generation publicly fetchable and bypass the review gate.
		professionalImageKey: approved ? rest.professionalImageKey : null,
		professionalAlphaKey: approved ? rest.professionalAlphaKey : null,
		professionalAlphaCutoutKey: approved
			? rest.professionalAlphaCutoutKey
			: null,
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
			// bookkeeping), so it must not be
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
			return row ?? null;
		}),
	);

/**
 * A background job untouched for longer than this is treated as dead. A queue
 * consumer that's killed mid-run (OOM, wall-clock eviction) never reaches its
 * catch block, so the row keeps its `processing`/`queued` status with no error
 * and sits "in flight" forever. Jobs finish in ~a minute (Replicate calls cap at
 * 120s each), so 5 minutes of no update is safely past the worst legitimate case.
 */
const STALE_JOB_MS = 5 * 60 * 1000;

/**
 * The error stamped on a reaped job. Split by pipeline so the guidance matches the
 * retry the UI actually offers — "Retry analysis" for a capture, "Apply again" in
 * the editor for a professional generation.
 */
const STALE_ANALYZE_NOTE =
	"Analysis was interrupted — the worker was terminated mid-job and it never finished. Retry analysis to try again.";
const STALE_PRO_NOTE =
	"Generation was interrupted — the worker was terminated mid-job and it never finished. Open the editor and Apply again to retry.";

/** One entry in the header "in flight" menu — a record with a running background job. */
export interface InFlightItem {
	id: number;
	artist: string;
	title: string;
	thumbKey: string | null;
	/** What's running, for the menu label. */
	kind: "analyze" | "professional";
	/** The finer-grained state (all actively running — the menu shows a spinner). */
	state: "pending" | "processing" | "queued";
}

/**
 * Everything currently in flight, for the admin header's queue dropdown: captures being
 * analysed (`status` pending/processing) and Apply jobs generating a photo
 * (`professionalJobStatus` queued/processing). Admin-only; returns a lightweight shape
 * (no capture bytes) polled on a short interval while anything is running. A record with
 * both a running analyze and pro job surfaces as its analyze (the more fundamental step).
 */
export const listInFlight = createServerFn({ method: "GET" }).handler(() =>
	Sentry.startSpan({ name: "listInFlight" }, async () => {
		if (!(await getAdminSession())) return [] as InFlightItem[];

		const db = getDb(env.DB);
		// Projected to only the columns InFlightItem + displayCoverKey need — this is
		// polled on a short interval, so pulling the whole row (incl. large JSON/text
		// columns) every few seconds would be wasted D1 work as the table grows.
		const rows = await db
			.select({
				id: records.id,
				artist: records.artist,
				title: records.title,
				status: records.status,
				professionalJobStatus: records.professionalJobStatus,
				professionalStatus: records.professionalStatus,
				professionalImageKey: records.professionalImageKey,
				capturePhotoKey: records.capturePhotoKey,
				updatedAt: records.updatedAt,
			})
			.from(records)
			.where(
				or(
					inArray(records.status, ["pending", "processing"]),
					inArray(records.professionalJobStatus, ["queued", "processing"]),
				),
			)
			.orderBy(desc(records.updatedAt));

		// Reap dead jobs so they leave the menu and offer a retry instead of
		// spinning forever. The status guard on each UPDATE makes it race-safe: a
		// job that legitimately finished between this SELECT and the UPDATE no
		// longer matches, so we never clobber a just-completed generation. This poll
		// is the only frequent code path, so it doubles as the self-heal sweep — no
		// extra cron needed. Reaped rows are dropped from the returned list below.
		const now = Date.now();
		const reaps: Promise<number | null>[] = [];
		for (const row of rows) {
			if (!row.updatedAt || now - row.updatedAt.getTime() <= STALE_JOB_MS) {
				continue;
			}
			const analyzing = row.status === "pending" || row.status === "processing";
			reaps.push(
				db
					.update(records)
					.set(
						analyzing
							? {
									status: "failed",
									error: STALE_ANALYZE_NOTE,
									updatedAt: new Date(),
								}
							: {
									professionalJobStatus: "failed",
									professionalError: STALE_PRO_NOTE,
									updatedAt: new Date(),
								},
					)
					.where(
						and(
							eq(records.id, row.id),
							analyzing
								? inArray(records.status, ["pending", "processing"])
								: inArray(records.professionalJobStatus, [
										"queued",
										"processing",
									]),
						),
					)
					// Only treat a row as reaped once its UPDATE lands. A swallowed
					// transient D1 error leaves the id out of `stale`, so the row stays
					// in the response and the next poll retries the reap — rather than
					// vanishing from the header while still in-flight in the DB.
					.then(() => row.id)
					.catch(() => null),
			);
		}
		const stale = new Set(
			(await Promise.all(reaps)).filter((id): id is number => id != null),
		);

		return rows
			.filter((row) => !stale.has(row.id))
			.map((row): InFlightItem => {
				const analyzing =
					row.status === "pending" || row.status === "processing";
				return {
					id: row.id,
					artist: row.artist,
					title: row.title,
					thumbKey: displayCoverKey(row, { includeCapture: true }),
					kind: analyzing ? "analyze" : "professional",
					state: analyzing
						? (row.status as "pending" | "processing")
						: (row.professionalJobStatus as "queued" | "processing"),
				};
			});
	}),
);

export const createRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => recordCreateSchema.parse(data))
	.handler(({ data }) =>
		Sentry.startSpan({ name: "createRecord" }, async () => {
			const db = getDb(env.DB);
			const { source, coverImageKey: provided, ...rest } = data;

			// Display cover comes from Discogs (resized → R2), not the iPhone shot —
			// unless one was provided (a manual upload), which we mark as such.
			let coverImageKey = provided ?? null;
			const coverIsUpload = Boolean(provided);
			if (!coverImageKey && rest.discogsId) {
				coverImageKey = await sourceCoverFromDiscogs(rest.discogsId);
			}

			const [row] = await db
				.insert(records)
				.values({
					...rest,
					coverImageKey,
					coverIsUpload,
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

			// Generate the first-pass professional photo inline. It's free, deterministic
			// pixel math (detect the sleeve's corners, warp, tone) — no external call — so
			// there's no queue: a straight, cropped square is ready the moment the capture
			// lands, and clicking it opens the editor pre-cropped. Best-effort and fully
			// independent of analysis: on failure we record it on the professional* track (a
			// manual re-crop retries) rather than failing the whole capture.
			try {
				const { professionalKey, band } = await professionalPipeline(row);
				// Generate the matte from the same detected corner band — deterministic
				// (free) on capture, no paid model call; the editor's Apply can upgrade it
				// to the matting model. Best-effort: a matte failure never fails the capture.
				const matte = await generateMatteFromCapture(
					capturePhotoKey,
					band,
					{},
					{ useAi: false },
				).catch((err) => {
					console.error("captureRecord: matte generation failed", err);
					return null;
				});
				const [pro] = await db
					.update(records)
					.set({
						professionalImageKey: professionalKey,
						// Persist the detected seed so the editor opens pre-cropped; a later
						// Apply overwrites it with the admin's band.
						sleeveCornersJson: serializeCornerBand(band),
						professionalAlphaKey: matte?.shadowKey ?? null,
						professionalAlphaCutoutKey: matte?.cutoutKey ?? null,
						professionalAlphaSource: matte?.source ?? null,
						// Generated, but not shown on the site until an admin approves it.
						professionalStatus: "ready",
						professionalError: null,
						updatedAt: new Date(),
					})
					.where(eq(records.id, row.id))
					.returning();
				return pro ?? row;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				const [failed] = await db
					.update(records)
					.set({
						professionalStatus: "failed",
						professionalError: `Could not generate professional photo: ${detail}`,
						updatedAt: new Date(),
					})
					.where(eq(records.id, row.id))
					.returning()
					.catch(() => []);
				return failed ?? row;
			}
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
			masterId?: string | null;
			masterUrl?: string | null;
			discogsId?: string | null;
			discogsUrl?: string | null;
			coverImageKey?: string | null;
		}) => ({
			id: input.id,
			data: recordInputSchema.parse(input.data),
			masterId: input.masterId ?? null,
			masterUrl: input.masterUrl ?? null,
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
		({
			data: {
				id,
				data,
				masterId,
				masterUrl,
				discogsId,
				discogsUrl,
				coverImageKey: uploaded,
			},
		}) =>
			Sentry.startSpan({ name: "publishRecord" }, async () => {
				const db = getDb(env.DB);
				const [current] = await db
					.select()
					.from(records)
					.where(eq(records.id, id))
					.limit(1);
				if (!current) return null;

				let coverImageKey = current.coverImageKey;
				let coverIsUpload = current.coverIsUpload ?? false;
				let coverFetchFailed = false;
				if (uploaded) {
					// A user-uploaded cover always wins over the Discogs artwork.
					coverImageKey = uploaded;
					coverIsUpload = true;
				} else if (discogsId && discogsId !== current.discogsId) {
					// New match → re-source its cover. If that fails, clear the cover
					// rather than keep the previous release's artwork (which would now be
					// wrong). The failure is logged in the cover pipeline and signalled
					// back so the admin gets a toast and can retry or upload manually.
					coverImageKey = await sourceCoverFromDiscogs(discogsId);
					coverFetchFailed = !coverImageKey;
					coverIsUpload = false;
				}

				const [row] = await db
					.update(records)
					.set({
						...data,
						masterId,
						masterUrl,
						discogsId,
						discogsUrl,
						coverImageKey,
						coverIsUpload,
						// A record is only publishable once it has an album (master). Without
						// one, save it back to `review` rather than pushing it live.
						status: masterId ? "complete" : "review",
						error: null,
						updatedAt: new Date(),
					})
					.where(eq(records.id, id))
					.returning();
				return row
					? { record: row, coverFetchFailed, needsMaster: !masterId }
					: null;
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
 * Re-pull a single record from Discogs, synchronously so the detail page gets the
 * updated row straight back. Re-pulls the pinned release (enrichment + value),
 * refreshes the album from its master, or — when neither is set — guesses a master
 * from the record's artist/title. Returns null if the record is gone or there's
 * nothing to refresh/guess from.
 */
export const refreshRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "refreshRecord" }, () => refreshRecordById(id)),
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
 * Kick off the paid "Apply" pipeline for a record — reframe + Real-ESRGAN enhance + AI
 * matte. The actual GPU work (~a minute) runs in the queue consumer
 * ({@link generateProfessionalPhoto}); this only persists the edited corners + tone knobs,
 * flags `professionalJobStatus: "queued"`, and enqueues the job, returning immediately so
 * the editor can close and the admin can move on. Crucially it does NOT touch the display
 * `professionalStatus`, so an already-approved cover stays live until the consumer swaps in
 * the new keys. Requires a capture to warp — throws if there's none. Returns the updated
 * row (now `queued`), or null if the record's gone.
 */
export const reframeRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(
		(input: { id: number; band?: CornerBand; params?: ReframeParams }) => ({
			id: input.id,
			// Runtime-sanitise untrusted input before it's persisted and later drives the
			// homography/tone math in the consumer: drop a malformed band (out of 0..1 or
			// non-finite → fall back to the stored crop) and keep only well-typed knobs.
			band: parseNormalizedCornerBand(input.band) ?? undefined,
			params: sanitizeReframeParams(input.params),
		}),
	)
	.handler(({ data: { id, band, params } }) =>
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
			// Use the edited band if supplied, else whatever's stored (or the
			// full-frame default for a record that's never been cropped).
			const effectiveBand = band ?? parseCornerBand(record.sleeveCornersJson);
			// Persist the crop + knobs so the consumer can pick them up, mark the job
			// queued, and hand off. `professionalStatus` is deliberately left as-is.
			const [row] = await db
				.update(records)
				.set({
					sleeveCornersJson: serializeCornerBand(effectiveBand),
					professionalParamsJson: JSON.stringify(params),
					professionalJobStatus: "queued",
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
 * Swap a record's source capture for a freshly uploaded photo, then regenerate the
 * first-pass professional crop from it — re-detecting the sleeve, since the stored
 * corners were for the old image. The result drops back to `ready` (unapproved), so
 * the admin re-approves via the editor. Best-effort R2 cleanup of the superseded
 * capture + professional objects. Returns the updated row, or null if it's gone.
 */
export const replaceCapture = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => {
		const d = (data ?? {}) as Record<string, unknown>;
		if (typeof d.id !== "number") throw new Error("id must be a number");
		if (typeof d.imageBase64 !== "string" || d.imageBase64.length === 0) {
			throw new Error("imageBase64 must be a non-empty string");
		}
		const mediaType =
			typeof d.mediaType === "string" && d.mediaType.startsWith("image/")
				? d.mediaType
				: "image/jpeg";
		return { id: d.id, imageBase64: d.imageBase64, mediaType };
	})
	.handler(({ data: { id, imageBase64, mediaType } }) =>
		Sentry.startSpan({ name: "replaceCapture" }, async () => {
			const db = getDb(env.DB);
			const [record] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!record) return null;

			const bytes = base64ToBytes(stripDataUrl(imageBase64));
			const { key: capturePhotoKey } = await storeCapturePhoto(
				bytes,
				mediaType,
			);

			// Regenerate from the new capture. Re-detect the sleeve (pass a null crop) —
			// the stored corners were for the old image. On failure keep the new capture
			// but mark the pro track failed, so the admin can crop it by hand.
			let professionalKey: string | null = null;
			let matte: {
				shadowKey: string;
				cutoutKey: string;
				source: "ai" | "deterministic";
			} | null = null;
			const proFields: {
				professionalImageKey?: string | null;
				sleeveCornersJson: string;
				professionalStatus: "ready" | "failed";
				professionalError: string | null;
				professionalAlphaKey: string | null;
				professionalAlphaCutoutKey: string | null;
				professionalAlphaSource: "ai" | "deterministic" | null;
			} = {
				sleeveCornersJson: serializeCornerBand(DEFAULT_BAND),
				professionalStatus: "failed",
				professionalError: null,
				professionalAlphaKey: null,
				professionalAlphaCutoutKey: null,
				professionalAlphaSource: null,
			};
			try {
				const gen = await professionalPipeline({
					capturePhotoKey,
					sleeveCornersJson: null,
					professionalParamsJson: record.professionalParamsJson,
				});
				professionalKey = gen.professionalKey;
				proFields.professionalImageKey = gen.professionalKey;
				proFields.sleeveCornersJson = serializeCornerBand(gen.band);
				proFields.professionalStatus = "ready";
				// A deterministic matte from the same detected corner band (free — no paid
				// call on a capture swap). Best-effort, independent of the square.
				matte = await generateMatteFromCapture(
					capturePhotoKey,
					gen.band,
					parseReframeParams(record.professionalParamsJson),
					{ useAi: false },
				).catch((err) => {
					console.error("replaceCapture: matte generation failed", err);
					return null;
				});
				proFields.professionalAlphaKey = matte?.shadowKey ?? null;
				proFields.professionalAlphaCutoutKey = matte?.cutoutKey ?? null;
				proFields.professionalAlphaSource = matte?.source ?? null;
			} catch (err) {
				proFields.professionalError =
					err instanceof Error ? err.message : String(err);
			}

			const [row] = await db
				.update(records)
				.set({
					capturePhotoKey,
					...proFields,
					// A new capture regenerates from scratch — no longer an upscale.
					professionalEnhanced: false,
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();

			// Bin the superseded objects — best-effort, so a transient R2 failure just
			// leaves an orphan rather than breaking the (already-updated) row.
			for (const staleKey of [
				record.capturePhotoKey,
				record.professionalImageKey,
				record.professionalAlphaKey,
				record.professionalAlphaCutoutKey,
			]) {
				if (
					staleKey &&
					staleKey !== capturePhotoKey &&
					staleKey !== professionalKey &&
					staleKey !== matte?.shadowKey &&
					staleKey !== matte?.cutoutKey
				) {
					await env.PHOTOS.delete(staleKey).catch(() => {});
				}
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
 * Remove the professional photo entirely — the "Remove cover" action. Deletes the
 * stored image from R2 and resets the record's whole professional* state to zero:
 * no key, status `idle`, not enhanced, and the crop corners + tone knobs cleared back
 * to their defaults. So the header falls back to the raw capture and a later edit opens
 * on a clean full-frame, default-tone slate. No-op (returns the row/null) if the record
 * is gone.
 */
export const clearProfessional = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "clearProfessional" }, async () => {
			const db = getDb(env.DB);
			const [record] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!record) return null;
			const stale = [
				record.professionalImageKey,
				record.professionalAlphaKey,
				record.professionalAlphaCutoutKey,
			].filter((k): k is string => Boolean(k));
			const [row] = await db
				.update(records)
				.set({
					professionalImageKey: null,
					professionalStatus: "idle",
					professionalEnhanced: false,
					professionalError: null,
					// Drop the matte alongside the square — both rebuild from a later edit.
					professionalAlphaKey: null,
					professionalAlphaCutoutKey: null,
					professionalAlphaSource: null,
					// Zero-state: drop the saved crop + tone so the editor reopens clean.
					sleeveCornersJson: null,
					professionalParamsJson: null,
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();
			// Best-effort R2 cleanup — the row already points at no image, so a failed
			// delete just leaves an orphan object, never a broken reference.
			if (stale.length > 0) await env.PHOTOS.delete(stale).catch(() => {});
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
 * Manual Discogs *master* (album) search — the editor's primary "pick an album"
 * flow. Mirrors `searchDiscogs` but over masters; failures propagate so the UI can
 * show why a search came back empty.
 */
export const searchDiscogsMasters = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => searchParamsSchema.parse(data))
	.handler(({ data }) =>
		Sentry.startSpan({ name: "searchDiscogsMasters" }, () =>
			searchMasters(data, MAX_PER_PAGE),
		),
	);

/**
 * List a master's vinyl pressings for the editor's "pick a specific release"
 * flow — the album's releases to choose from once it's linked. Returns [] on
 * failure so the picker just shows nothing rather than erroring.
 */
export const getDiscogsMasterVersions = createServerFn({ method: "GET" })
	.middleware([authMiddleware])
	.validator((id: string) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "getDiscogsMasterVersions" }, () =>
			getMasterVersions(id).catch(() => []),
		),
	);

/**
 * Resolve a pasted Discogs master URL (or bare id) into a single master candidate,
 * so an album can be pinned without searching. Returns null for anything that
 * isn't a resolvable master.
 */
export const lookupDiscogsMaster = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => {
		if (typeof data !== "string") {
			throw new Error("Expected a Discogs master URL or id");
		}
		return data;
	})
	.handler(({ data: input }) =>
		Sentry.startSpan({ name: "lookupDiscogsMaster" }, () => {
			const id = parseMasterId(input);
			if (!id) return null;
			return getMasterCandidate(id).catch(() => null);
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
					professionalAlphaKey: records.professionalAlphaKey,
					professionalAlphaCutoutKey: records.professionalAlphaCutoutKey,
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
					row.professionalAlphaKey,
					row.professionalAlphaCutoutKey,
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
 * Bulk publish. Flips the selected rows to `complete` so they appear on the
 * public homepage. Shares one timestamp across chunks. Returns how many rows were
 * published — rows without a `masterId` are silently skipped (a record needs an
 * album to be publishable), so the count can be lower than the selection.
 */
export const publishRecords = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "publishRecords" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			const now = new Date();
			let count = 0;
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.update(records)
					// Clear `error` too: it's only meaningful while `status === "failed"`,
					// so publishing a previously-failed row must not leave it behind.
					.set({ status: "complete", error: null, updatedAt: now })
					// A record is only publishable once it has an album (master).
					.where(and(inArray(records.id, batch), isNotNull(records.masterId)))
					.returning({ id: records.id });
				count += rows.length;
			}
			return { count };
		}),
	);

/**
 * Bulk unpublish. Drops the selected rows back to `review` so they leave the
 * public homepage but stay in the admin queue. Returns how many rows were
 * unpublished.
 */
export const unpublishRecords = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "unpublishRecords" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			const now = new Date();
			let count = 0;
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.update(records)
					// Clear any stale failure error — the row is now a normal review item.
					.set({ status: "review", error: null, updatedAt: now })
					.where(inArray(records.id, batch))
					.returning({ id: records.id });
				count += rows.length;
			}
			return { count };
		}),
	);

/**
 * Bulk refresh. Enqueues a Discogs re-pull for each selected record through the
 * queue (so it respects Discogs' rate limit rather than firing N synchronous
 * fetches). Per record, the consumer re-pulls the pinned release, refreshes the
 * album from its master, or — when neither is set — guesses a master from the
 * record's artist/title. Every real record has an artist/title, so all selected
 * rows are enqueued; only rows with neither Discogs link nor artist/title no-op.
 * Returns how many refreshes were queued.
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
					// Enqueue anything with a Discogs link (re-pull) or an artist/title to
					// guess a master from. `artist` is NOT NULL, so this matches every row;
					// the guard documents intent and future-proofs against blank imports.
					.where(
						and(
							inArray(records.id, batch),
							or(
								isNotNull(records.discogsId),
								isNotNull(records.masterId),
								isNotNull(records.artist),
							),
						),
					);
				matched.push(...rows.map(({ id }) => id));
			}
			await enqueueRefreshBatch(matched);
			return { count: matched.length };
		}),
	);
