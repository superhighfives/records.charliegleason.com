import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import {
	and,
	count,
	desc,
	eq,
	getTableColumns,
	inArray,
	isNotNull,
	isNull,
	or,
} from "drizzle-orm";

import { getDb } from "#/db";
import {
	colors,
	type JobStep,
	matteAuditState,
	type Record as RecordRow,
	records,
} from "#/db/schema";
import { identifyFromAsin } from "#/lib/asin";
import { AdminSessionError, authMiddleware, getAdminSession } from "#/lib/auth";
import {
	chunk,
	D1_PARAM_CHUNK,
	MAX_AUTO_RETRIES,
	STALE_JOB_MS,
	staleThresholdMs,
} from "#/lib/batching";
import { DEFAULT_COLOR_NAME, getOrCreateColor } from "#/lib/colors";
import { displayCoverKey } from "#/lib/cover";
import {
	getMasterCandidate,
	getMasterVersions,
	getReleaseCandidate,
	getReleaseDetail,
	getReleaseValue,
	MAX_PER_PAGE,
	parseAsin,
	parseBarcode,
	parseMasterId,
	parseReleaseId,
	searchByBarcode,
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
import {
	type LinkHealthResult,
	MANUAL_CHECK_BATCH,
	runLinkHealthCheck,
} from "#/lib/master-health";
import { generateMatteFromCapture } from "#/lib/matte";
import { beginMatteAuditSweep, getRunningMatteAudit } from "#/lib/matte-audit";
import { hasMatteAuditFixReason } from "#/lib/photo-processing";
import { detectCaptureCorners, professionalPipeline } from "#/lib/professional";
import type { CoverStageResult } from "#/lib/professional-pipeline";
import {
	enqueueAnalyze,
	enqueueAnalyzeBatch,
	enqueueAuditMattes,
	enqueueProfessional,
	enqueueProfessionalBatch,
	enqueueProfessionalMatte,
	enqueueProfessionalMatteBatch,
	enqueueRefreshBatch,
	enqueueResolveAsinBatch,
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
 * Coerce a maybe-blank string to null. A `""` Discogs id is non-null in SQLite —
 * it would slip past `IS NOT NULL` publish gating while reading as "missing" in
 * JS — so trim and null blanks before they persist.
 */
function blankToNull(v: string | null | undefined): string | null {
	const t = v?.trim();
	return t ? t : null;
}

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

/** A `records` row joined with its `colors` chip — see `listPublicRecords`. */
type RecordRowWithColor = RecordRow & {
	colorName: string | null;
	colorTextureImageKey: string | null;
	colorTextureStatus: string | null;
	colorPalette: string | null;
	colorTranslucent: boolean | null;
};

/**
 * The public shape of a record — the full row minus the admin-only fields, plus a
 * derived `copies` count (how many physical copies of this album the collector
 * owns: 1 for a normal record, ≥2 when secondary copies are linked to it via
 * `copyOf`), and the joined color chip's name + reference vinyl texture (for
 * `VinylDisc`). Secondary copies themselves are never in the public list.
 */
export type PublicRecord = Omit<
	RecordRowWithColor,
	(typeof ADMIN_ONLY_FIELDS)[number]
> & {
	copies: number;
};

/**
 * Drop the admin-only fields from a row so it's safe to return publicly. `copies`
 * is the number of physical copies owned (default 1); `listPublicRecords` passes
 * the real count for a primary that has linked secondary copies.
 */
export function toPublicRecord(
	row: RecordRowWithColor,
	copies = 1,
): PublicRecord {
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
		copies,
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
		// Admin-only: returns full rows (capture keys, valuation, bookkeeping), so it
		// must not be callable unauthenticated. Both this and `getRecord` are loaded via
		// `useSuspenseQuery`/`ensureQueryData` under the `/admin` route, which has an
		// `errorComponent` (route.tsx) — so throwing here surfaces a clear retry prompt
		// instead of a silent empty collection indistinguishable from "you own zero
		// records" (see `AdminSessionError`). Failing closed still means an auth outage
		// never leaks data, it just no longer leaks it as an unremarkable empty list.
		if (!(await getAdminSession())) throw new AdminSessionError();
		const db = getDb(env.DB);
		return db.select().from(records).orderBy(desc(records.createdAt));
	}),
);

/**
 * Public list for the homepage — only published (`complete`) records, and omits
 * the admin-only iPhone capture key. In-flight / failed captures stay private.
 * Also the single source for the `/api/records` JSON route, which just calls this
 * (rather than re-running the query) so the copy-exclusion + counts never drift.
 *
 * NB: the query lives inside this `createServerFn` handler on purpose. `records.ts`
 * is reachable from client code (via `records-queries.ts`), and only server-fn
 * handler bodies get the `cloudflare:workers` (`env`) import stripped from the
 * client bundle — a plain exported helper touching `env` breaks the client build.
 */
export const listPublicRecords = createServerFn({ method: "GET" }).handler(() =>
	Sentry.startSpan({ name: "listPublicRecords" }, async () => {
		const db = getDb(env.DB);
		// Count linked secondary copies per primary across the WHOLE table — a copy is
		// counted even if it isn't itself published (an unmatched/review duplicate still
		// means the collector owns two), and it never appears in the public list itself.
		// `copyOf IS NOT NULL` scopes this to just the copies, so it's a small aggregate.
		const copyCounts = await db
			.select({ copyOf: records.copyOf, count: count() })
			.from(records)
			.where(isNotNull(records.copyOf))
			.groupBy(records.copyOf);
		const copiesByPrimary = new Map(copyCounts.map((r) => [r.copyOf, r.count]));
		// Public = published AND has an identity (a master album and/or a specific
		// release — some releases have no master group on Discogs at all), AND is
		// not itself a secondary copy (those are represented by the primary's count,
		// not their own tile). The identity requirement is defence-in-depth for the
		// publish gate: even if a row slipped to `complete` without one, it never
		// surfaces publicly without something to link back to Discogs.
		const rows = await db
			.select({
				...getTableColumns(records),
				colorName: colors.name,
				colorTextureImageKey: colors.textureImageKey,
				colorTextureStatus: colors.textureStatus,
				colorPalette: colors.palette,
				colorTranslucent: colors.translucent,
			})
			.from(records)
			.leftJoin(colors, eq(records.colorId, colors.id))
			.where(
				and(
					eq(records.status, "complete"),
					or(isNotNull(records.masterId), isNotNull(records.discogsId)),
					isNull(records.copyOf),
				),
			)
			.orderBy(desc(records.createdAt));
		// `copies` = the primary itself (1) plus any secondaries pointing at it.
		return rows.map((row) =>
			toPublicRecord(row, 1 + (copiesByPrimary.get(row.id) ?? 0)),
		);
	}),
);

export const getRecord = createServerFn({ method: "GET" })
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "getRecord" }, async () => {
			// Admin-only: this returns the full row (capture key, valuation, professional*
			// bookkeeping), so it must not be callable unauthenticated. See `listRecords` —
			// throws rather than returning `null`, which the record page couldn't tell
			// apart from a genuinely deleted/bad id ("Record not found").
			if (!(await getAdminSession())) throw new AdminSessionError();

			const db = getDb(env.DB);
			const [row] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			return row ?? null;
		}),
	);

/** The terminal result of a record's last job, for the header queue's finished rows. */
export interface QueueOutcome {
	id: number;
	/**
	 * `failed` — the analyze or Apply job ended in `failed`; `fallback` — the Apply landed a
	 * cover but on the deterministic matte, not the AI one (Magic matte unavailable); `ok` —
	 * a clean finish.
	 */
	outcome: "ok" | "fallback" | "failed";
	/**
	 * The record's *current* display cover key, so the finished row can render a live thumbnail
	 * instead of the key the client froze into its session history — a later re-Apply rewrites
	 * the professional image under a new key and deletes the old object, which would 404 the
	 * frozen key. Null when there's nothing to show (no approved photo and no capture).
	 */
	coverKey: string | null;
}

/**
 * Terminal outcomes for a set of records, for the header queue's finished rows. The queue
 * derives "finished" client-side by diffing the in-flight set, so an item just vanishes the
 * instant its job ends — the client never sees the final state. This fills that gap: given
 * the ids the client is holding in its session history, report whether each failed, landed
 * on the deterministic matte, or finished clean, so the menu can flag them. Admin-only; ids
 * come from the bounded client history (≤ MAX_FINISHED), so this is a single small lookup.
 */
export const listQueueOutcomes = createServerFn({ method: "GET" })
	.validator((ids: unknown) =>
		Array.isArray(ids)
			? ids.filter((n): n is number => typeof n === "number")
			: [],
	)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "listQueueOutcomes" }, async () => {
			if (!(await getAdminSession())) return [] as QueueOutcome[];
			if (ids.length === 0) return [] as QueueOutcome[];

			const db = getDb(env.DB);
			const rows = await db
				.select({
					id: records.id,
					status: records.status,
					professionalJobStatus: records.professionalJobStatus,
					professionalAlphaSource: records.professionalAlphaSource,
					professionalStatus: records.professionalStatus,
					professionalImageKey: records.professionalImageKey,
					capturePhotoKey: records.capturePhotoKey,
					amazonResolveStatus: records.amazonResolveStatus,
				})
				.from(records)
				// Bounded to the client's history size; clamp defensively so a tampered
				// payload can't blow past D1's bound-parameter limit.
				.where(inArray(records.id, ids.slice(0, 50)));

			return rows.map((row): QueueOutcome => {
				// Current cover so the finished row shows a live thumbnail, not the client's
				// frozen (possibly-since-deleted) key. Admin surface, so include the capture.
				const coverKey = displayCoverKey(row, { includeCapture: true });
				// A hard failure on either pipeline (or a failed Amazon resolve — the "amazon"
				// InFlightItem kind departs into this same finished-history flow) reads red; a
				// landed-but-downgraded matte (AI unavailable → deterministic) reads amber;
				// anything else is a clean finish.
				if (
					row.status === "failed" ||
					row.professionalJobStatus === "failed" ||
					row.amazonResolveStatus === "failed"
				)
					return { id: row.id, outcome: "failed", coverKey };
				if (row.professionalAlphaSource === "deterministic")
					return { id: row.id, outcome: "fallback", coverKey };
				return { id: row.id, outcome: "ok", coverKey };
			});
		}),
	);

/**
 * The error stamped on a reaped job. The analyze note carries its own retry guidance
 * (its failure display shows the note verbatim). The pro note deliberately does NOT: the
 * editor appends the "Apply again" guidance to *every* professional failure — reaper note
 * or matte failure — uniformly (see records.$id.tsx), so embedding it here too would
 * double it on the reaper case.
 */
const STALE_ANALYZE_NOTE =
	"Analysis was interrupted — the worker was terminated mid-job and it never finished. Retry analysis to try again.";
const STALE_PRO_NOTE =
	"Generation was interrupted — the worker was terminated mid-job and it never finished.";

/** One entry in the header "in flight" menu — a record with a running background job. */
export interface InFlightItem {
	/**
	 * Null only for `kind: "audit"` — a sweep isn't a single record, so there's nowhere
	 * for the menu to link it. Every other kind is always a real record id.
	 */
	id: number | null;
	artist: string;
	title: string;
	thumbKey: string | null;
	/** What's running, for the menu label. */
	kind: "analyze" | "professional" | "amazon" | "audit";
	/** The finer-grained state (all actively running — the menu shows a spinner). */
	state: "pending" | "processing" | "queued";
	/**
	 * For a processing `professional` job, which of the two Apply stages it's in, so the
	 * menu can show "(1/2)" (cover) vs "(2/2)" (matte). Null for analyze jobs, queued
	 * professional jobs, and legacy rows with no stage recorded.
	 */
	stage: "cover" | "matte" | null;
	/**
	 * The fine-grained sub-step within whichever pipeline is running (see `records.jobStep`),
	 * so the menu can show "(2/4) Enhancing" / "(1/4) Reading cover". Null for a queued job
	 * not yet started, a freshly re-enqueued one, and legacy rows — the menu falls back to
	 * the coarse stage label.
	 */
	step: JobStep | null;
}

/**
 * Terminally fail every in-flight job — the "Fail all" escape hatch in the header queue,
 * for when the pipeline is thrashing (e.g. a matte stage OOM-looping: it dies uncatchably,
 * the row stays `processing`, and the reaper keeps re-enqueuing it). Flags both pipelines
 * failed so the reaper stops touching them and each becomes a manual-retry-able row —
 * `professionalStatus` / analysis fields are left intact, so an already-live cover or a
 * prior analysis survives. Clears the progress markers (`professionalStage`, `jobStep`).
 * Also stops the two non-record job kinds the queue menu can show (`amazonResolveStatus`
 * queued rows, and a running matte-audit sweep) — like the record pipelines above, this
 * flips the DB-tracked state so the UI/reaper stop treating them as running; it can't
 * cancel an already-sent queue message (Cloudflare Queues has no cancel API), so a
 * genuinely in-flight message still runs to completion and may overwrite the stopped
 * state on its own success/failure path, same as the existing record pipelines. Admin-only.
 * Returns how many rows it stopped.
 */
export const failAllInFlight = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(() =>
		Sentry.startSpan({ name: "failAllInFlight" }, async () => {
			const db = getDb(env.DB);
			const note = "Stopped from the queue — Apply / retry to run it again.";

			const [pro, analyze, amazon] = await Promise.all([
				db
					.update(records)
					.set({
						professionalJobStatus: "failed",
						professionalStage: null,
						jobStep: null,
						professionalError: note,
						updatedAt: new Date(),
					})
					.where(
						inArray(records.professionalJobStatus, ["queued", "processing"]),
					)
					.returning({ id: records.id }),
				db
					.update(records)
					.set({
						status: "failed",
						jobStep: null,
						error: note,
						updatedAt: new Date(),
					})
					.where(inArray(records.status, ["pending", "processing"]))
					.returning({ id: records.id }),
				db
					.update(records)
					.set({
						amazonResolveStatus: "failed",
						amazonResolveError: note,
						updatedAt: new Date(),
					})
					.where(eq(records.amazonResolveStatus, "queued"))
					.returning({ id: records.id }),
				db
					.update(matteAuditState)
					.set({ running: false, updatedAt: new Date() })
					.where(eq(matteAuditState.id, 1)),
			]);

			// A record with both a running analyze and pro job is one stopped row, not two.
			const ids = new Set([...pro, ...analyze, ...amazon].map((r) => r.id));
			return { count: ids.size };
		}),
	);

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
		// columns) every few seconds would be wasted D1 work as the table grows. The three
		// selects are independent (none depends on another's result), so they run
		// concurrently rather than adding up their round-trip latencies on a path that's
		// polled every few seconds while anything is in flight.
		const [rows, amazonRows, auditProgress] = await Promise.all([
			db
				.select({
					id: records.id,
					artist: records.artist,
					title: records.title,
					status: records.status,
					professionalJobStatus: records.professionalJobStatus,
					professionalStage: records.professionalStage,
					jobStep: records.jobStep,
					professionalStatus: records.professionalStatus,
					professionalImageKey: records.professionalImageKey,
					capturePhotoKey: records.capturePhotoKey,
					analyzeRetryCount: records.analyzeRetryCount,
					professionalRetryCount: records.professionalRetryCount,
					updatedAt: records.updatedAt,
				})
				.from(records)
				.where(
					or(
						inArray(records.status, ["pending", "processing"]),
						inArray(records.professionalJobStatus, ["queued", "processing"]),
					),
				)
				.orderBy(desc(records.updatedAt)),
			// Amazon ASIN→pressing resolutions — a separate, much simpler lifecycle (see
			// `amazonResolveStatus` in schema.ts): one queue message either pins a release or
			// gives up, both fast and terminal, so there's normally no "processing" state.
			// `updatedAt` is still selected so the reap loop below can catch the one failure
			// mode that isn't self-clearing — a message dropped before the consumer ever runs.
			db
				.select({
					id: records.id,
					artist: records.artist,
					title: records.title,
					capturePhotoKey: records.capturePhotoKey,
					professionalImageKey: records.professionalImageKey,
					professionalStatus: records.professionalStatus,
					updatedAt: records.updatedAt,
				})
				.from(records)
				.where(eq(records.amazonResolveStatus, "queued")),
			// A running audit sweep is one item, not one per record — id null, no thumb.
			getRunningMatteAudit(),
		]);

		// Reap dead jobs so they don't spin forever. Each is either re-enqueued (a fresh,
		// clean-isolate run, while its auto-retry budget lasts) or flagged terminally failed
		// for manual action. The status guard on each UPDATE makes it race-safe: a job that
		// legitimately finished between this SELECT and the UPDATE no longer matches, so we
		// never clobber a just-completed generation. This poll is the only frequent code
		// path, so it doubles as the self-heal sweep — no extra cron needed. `outcome`
		// distinguishes the two: a re-enqueued job is still in flight (stays in the menu, and
		// we send it a fresh queue message); a failed one is dropped from the returned list.
		const now = Date.now();
		const reaps: Promise<{ id: number; outcome: "retry" | "fail" } | null>[] =
			[];
		for (const row of rows) {
			const analyzing = row.status === "pending" || row.status === "processing";
			const retryCount =
				(analyzing ? row.analyzeRetryCount : row.professionalRetryCount) ?? 0;
			if (
				!row.updatedAt ||
				now - row.updatedAt.getTime() <= staleThresholdMs(retryCount)
			) {
				continue;
			}
			// Under budget → re-enqueue a fresh job (clear the error, bump the counter, keep
			// it in the running state); budget exhausted → flag failed with the interrupted
			// note so the editor offers a manual retry.
			const willRetry = retryCount < MAX_AUTO_RETRIES;
			const outcome: "retry" | "fail" = willRetry ? "retry" : "fail";
			reaps.push(
				db
					.update(records)
					.set(
						analyzing
							? willRetry
								? {
										status: "pending",
										error: null,
										// A reaped job restarts from its first sub-step — drop the
										// stale marker so a queued row can't show a live step.
										jobStep: null,
										analyzeRetryCount: retryCount + 1,
										updatedAt: new Date(),
									}
								: {
										status: "failed",
										error: STALE_ANALYZE_NOTE,
										jobStep: null,
										updatedAt: new Date(),
									}
							: willRetry
								? {
										professionalJobStatus: "queued",
										professionalError: null,
										jobStep: null,
										professionalRetryCount: retryCount + 1,
										updatedAt: new Date(),
									}
								: {
										professionalJobStatus: "failed",
										professionalError: STALE_PRO_NOTE,
										jobStep: null,
										updatedAt: new Date(),
									},
					)
					.where(
						and(
							eq(records.id, row.id),
							// Optimistic lock on the exact timestamp we read: exactly one writer
							// wins, so concurrent polls (or a race with the job finishing) can't
							// double-enqueue / double-count. A re-enqueue lands the row back in
							// `queued`/`pending` — inside the status guard below — so unlike the
							// old always-`failed` reap, the status guard alone is NOT idempotent.
							eq(records.updatedAt, row.updatedAt),
							analyzing
								? inArray(records.status, ["pending", "processing"])
								: inArray(records.professionalJobStatus, [
										"queued",
										"processing",
									]),
						),
					)
					.returning({ id: records.id })
					// Only act on a row once its UPDATE lands. A swallowed transient D1 error
					// (or a lost race with a job that just finished) leaves it out of `reaped`,
					// so the row stays in the response and the next poll retries the sweep —
					// rather than vanishing from the header (or double-enqueuing) mid-flight.
					.then((r) => (r.length ? { id: row.id, outcome } : null))
					.catch(() => null),
			);
		}
		const reaped = (await Promise.all(reaps)).filter(
			(r): r is { id: number; outcome: "retry" | "fail" } => r != null,
		);
		const reapedOutcome = new Map(reaped.map((r) => [r.id, r.outcome]));
		// Send the fresh queue message only after the row-state UPDATE committed, so a failed
		// enqueue can't leave a row flagged running with nothing actually queued (the next
		// poll re-reaps it). A row that fell out of the running state before its UPDATE
		// landed simply isn't in `reaped`. Each send is isolated: a transient Queues-binding
		// failure on one row must not throw out of the handler (this whole fn would 500) nor
		// skip the remaining rows' sends. The row is already flipped to queued/pending, so
		// the next poll re-reaps and re-sends it; we just log so the miss isn't silent.
		for (const { id, outcome } of reaped) {
			const wasAnalyzing = rows.find((r) => r.id === id)?.status;
			const analyzing =
				wasAnalyzing === "pending" || wasAnalyzing === "processing";
			// A terminally-failed reap is otherwise invisible to Sentry: the job died by an
			// uncatchable isolate/container teardown (an OOM, or a container rollout with no
			// drain grace), so no catch block ever ran to report it — the reaper is the only
			// place that observes the job gave up. Surface it here so a burst shows up as an
			// alert, not just rows behind the admin `?f=genFailed` filter. captureMessage (not
			// Exception): there's no error object — the failure was the *absence* of a
			// completion, not a throw.
			if (outcome === "fail") {
				Sentry.captureMessage(
					`[reaper] ${analyzing ? "analyze" : "professional"} job for record ${id} terminally failed after ${MAX_AUTO_RETRIES} auto-retries (worker terminated mid-job)`,
					"error",
				);
				continue;
			}
			try {
				await (analyzing ? enqueueAnalyze(id) : enqueueProfessional(id));
			} catch (err) {
				console.error(`[reaper] re-enqueue failed for record ${id}`, err);
				Sentry.captureException(err);
			}
		}
		// Only terminally-failed rows leave the in-flight menu; re-enqueued ones are still
		// running (freshly `queued`/`pending`) and stay.
		const dropped = new Set(
			reaped.filter((r) => r.outcome === "fail").map((r) => r.id),
		);

		// Stale-reap Amazon resolves too: `resolveAsinForRecord`'s own catch block clears
		// "queued" on every path it can reach, but a message dropped before the consumer
		// ever runs (a Queues delivery failure, not a catchable error) would otherwise leave
		// the row "queued" forever — permanently stuck in this menu and permanently excluded
		// from re-import (amazon-import-dialog.tsx's `!== "queued"` filter). Not auto-retried
		// (matching the design elsewhere: these jobs are best-effort, not retried), just
		// flagged failed so a human can re-run the import.
		const amazonReaps = amazonRows
			.filter(
				(row) => row.updatedAt && now - row.updatedAt.getTime() > STALE_JOB_MS,
			)
			.map((row) =>
				db
					.update(records)
					.set({
						amazonResolveStatus: "failed",
						amazonResolveError:
							"Stopped — the lookup never completed. Re-run the Amazon import to retry.",
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(records.id, row.id),
							eq(records.amazonResolveStatus, "queued"),
						),
					)
					.then(() => row.id)
					.catch(() => null),
			);
		const staleAmazonIds = new Set(
			(await Promise.all(amazonReaps)).filter((id): id is number => id != null),
		);

		const amazonItems: InFlightItem[] = amazonRows
			.filter((row) => !staleAmazonIds.has(row.id))
			.map((row) => ({
				id: row.id,
				artist: row.artist,
				title: row.title,
				thumbKey: displayCoverKey(row, { includeCapture: true }),
				kind: "amazon",
				state: "queued",
				stage: null,
				step: null,
			}));

		const auditItems: InFlightItem[] = auditProgress
			? [
					{
						id: null,
						artist: "Auditing covers",
						title: `${auditProgress.checked} checked · ${auditProgress.suspects} flagged so far`,
						thumbKey: null,
						kind: "audit",
						state: "processing",
						stage: null,
						step: null,
					},
				]
			: [];

		return [
			...rows
				.filter((row) => !dropped.has(row.id))
				.map((row): InFlightItem => {
					const analyzing =
						row.status === "pending" || row.status === "processing";
					// A row re-enqueued in THIS sweep was just flipped to queued/pending with a
					// fresh, stage-less job — reflect that rather than the pre-reap `rows`
					// snapshot's now-stale `processing`/`stage` (which would otherwise show a
					// plausible-but-wrong "still running stage N" for up to STALE_JOB_MS).
					const retried = reapedOutcome.get(row.id) === "retry";
					return {
						id: row.id,
						artist: row.artist,
						title: row.title,
						thumbKey: displayCoverKey(row, { includeCapture: true }),
						kind: analyzing ? "analyze" : "professional",
						state: analyzing
							? retried
								? "pending"
								: (row.status as "pending" | "processing")
							: retried
								? "queued"
								: (row.professionalJobStatus as "queued" | "processing"),
						// Only meaningful for a processing professional job; a freshly re-enqueued
						// one hasn't entered a stage yet, so null.
						stage: analyzing || retried ? null : row.professionalStage,
						// A re-enqueued job restarts from its first sub-step — the pre-reap
						// snapshot's `jobStep` is stale, so null it (mirrors `stage` above).
						step: retried ? null : row.jobStep,
					};
				}),
			...amazonItems,
			...auditItems,
		];
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

			// Vinyl color is manual-only (see `records.colorId`), so this is the one
			// place it's ever set automatically — a one-time default at creation,
			// never touched again by a refresh/re-match.
			const colorId =
				rest.colorId ?? (await getOrCreateColor(DEFAULT_COLOR_NAME)).id;

			const [row] = await db
				.insert(records)
				.values({
					...rest,
					colorId,
					coverImageKey,
					coverIsUpload,
					source: source ?? "manual",
					// A record is only publishable once it has an album (master) — mirror
					// the publishRecord gate so a manual entry without one lands as a draft
					// rather than straight onto the public homepage.
					status: rest.masterId ? "complete" : "review",
				})
				.returning();
			return row;
		}),
	);

/**
 * Capture flow entry: insert a `pending` row for an already-stored capture photo
 * and enqueue it for background analysis. Returns the new row so the UI can jump
 * straight to its detail page and watch the AI work land.
 *
 * Not a server fn: the capture uploads its photo as a raw request body to
 * `/api/admin/capture` (which streams it to R2 and then calls this), because a
 * base64-in-JSON payload held ~6 copies of the photo in the isolate and blew
 * the 128 MB memory limit on unshrunk originals.
 */
export function createCaptureRecord(data: {
	capturePhotoKey: string;
	context?: string;
	colorId?: number;
}): Promise<RecordRow> {
	return Sentry.startSpan({ name: "captureRecord" }, async () => {
		const db = getDb(env.DB);
		const { capturePhotoKey } = data;

		// Vinyl color is manual-only (see `records.colorId`) and the analyze
		// pipeline never sets it, so default it here at creation — same as
		// `createRecord` — rather than leaving every captured record uncolored.
		const colorId =
			data.colorId ?? (await getOrCreateColor(DEFAULT_COLOR_NAME)).id;

		const [row] = await db
			.insert(records)
			.values({
				artist: "",
				title: "",
				format: "LP",
				source: "photo",
				status: "pending",
				colorId,
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
	});
}

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
			// Coerce blanks to null: a `""` masterId is non-null in SQLite and would
			// slip past the `IS NOT NULL` publish gate while reading as "missing" in JS.
			masterId: blankToNull(input.masterId),
			masterUrl: blankToNull(input.masterUrl),
			discogsId: blankToNull(input.discogsId),
			discogsUrl: blankToNull(input.discogsUrl),
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

				// The public site shows the approved professional photo (and its matte),
				// never the Discogs cover — so a record with no approved photo would
				// publish to a placeholder. Gate on the SAME rule the UI displays by
				// (displayCoverKey), so the publish gate can't drift from what goes live.
				// (The bulk publishRecords mirrors this as a SQL predicate.)
				const hasCover = displayCoverKey(current) != null;
				// A record's identity can be an album (master) or a specific pressing
				// (release) — some releases have no master group on Discogs at all.
				const hasIdentity = Boolean(masterId || discogsId);

				const [row] = await db
					.update(records)
					.set({
						...data,
						masterId,
						masterUrl,
						discogsId,
						discogsUrl,
						// Re-linking clears the matching health flag so a record fixed in
						// the editor drops out of the broken-link banner without waiting for
						// the next scheduled pass (which re-validates it anyway). Only on an
						// actual change of the id — an unrelated save (e.g. editing notes)
						// leaves the flag as the link-check set it.
						...(masterId !== current.masterId ? { masterMissing: false } : {}),
						...(discogsId !== current.discogsId
							? { releaseMissing: false }
							: {}),
						coverImageKey,
						coverIsUpload,
						// A record is only publishable once it has an identity (master
						// and/or release) *and* an approved cover/matte to display. Missing
						// either, save it back to `review` rather than pushing it live.
						status: hasIdentity && hasCover ? "complete" : "review",
						error: null,
						updatedAt: new Date(),
					})
					.where(eq(records.id, id))
					.returning();
				return row
					? {
							record: row,
							coverFetchFailed,
							needsMaster: !hasIdentity,
							needsCover: hasIdentity ? !hasCover : false,
						}
					: null;
			}),
	);

/**
 * Take a published record back to `review` (drafts) — the inverse of publishing.
 * Removes it from the public collection without touching any of its data, so it
 * can be published again unchanged. Returns the updated row, or null when the
 * record no longer exists.
 */
export const unpublishRecord = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "unpublishRecord" }, async () => {
			const db = getDb(env.DB);
			const [row] = await db
				.update(records)
				.set({ status: "review", updatedAt: new Date() })
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
				// Fresh manual retry → reset the reaper's auto-retry budget.
				.set({
					status: "pending",
					error: null,
					analyzeRetryCount: 0,
					updatedAt: new Date(),
				})
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
 * matte. The actual GPU work (~a minute) runs in the queue consumer, split across two
 * isolates ({@link generateProfessionalCover} then {@link commitProfessionalMatte}). This
 * server fn only persists the edited corners + tone knobs, flags
 * `professionalJobStatus: "queued"`, and enqueues the job — returning immediately so the
 * editor can close and the admin can move on. Crucially it does NOT touch the display
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
					professionalStage: "cover",
					professionalError: null,
					// Fresh manual Apply → reset the reaper's auto-retry budget.
					professionalRetryCount: 0,
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();
			await enqueueProfessional(id);
			return row ?? null;
		}),
	);

/**
 * Re-run ONLY the Magic matte for a record whose last Apply landed the deterministic fallback
 * (the amber "Magic matte unavailable…" note) — a transient stage-2 blip, not a bad cover. It
 * reconstructs the stage-1 {@link CoverStageResult} snapshot from the row (the already-good
 * `professionalImageKey` as `coverKey`, plus the same capture + corners + tone the cover was
 * cut from) and re-enqueues stage 2 via {@link enqueueProfessionalMatte} — skipping the
 * (successful) reframe + Real-ESRGAN enhance that {@link reframeRecord} would redo. The matte
 * is still cut from the capture + band + params, so it stays consistent with the live cover,
 * which swaps in atomically only if the Magic matte succeeds. Like `reframeRecord`, this leaves
 * the display `professionalStatus` untouched (the fallback cover stays live) and only flips
 * `professionalJobStatus: "queued"`. Throws if there's no cover/capture to matte from.
 */
export const retryProfessionalMatte = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((input: { id: number }) => ({ id: input.id }))
	.handler(({ data: { id } }) =>
		Sentry.startSpan({ name: "retryProfessionalMatte" }, async () => {
			const db = getDb(env.DB);
			const [record] = await db
				.select()
				.from(records)
				.where(eq(records.id, id))
				.limit(1);
			if (!record) return null;
			if (!record.capturePhotoKey) {
				throw new Error("This record has no capture photo to matte from.");
			}
			if (!record.professionalImageKey) {
				throw new Error("This record has no professional cover to matte.");
			}
			// Rebuild the exact stage-1 snapshot the cover was committed from (mirrors
			// generateProfessionalCover's output) so the re-run matte is cut from the same
			// inputs as the live cover — the cover key rides through unchanged and re-commits
			// to itself (never binned), only the matte keys are replaced.
			const band = parseCornerBand(record.sleeveCornersJson);
			const params = parseReframeParams(record.professionalParamsJson);
			const stage: CoverStageResult = {
				coverKey: record.professionalImageKey,
				enhanced: record.professionalEnhanced ?? false,
				captureKey: record.capturePhotoKey,
				bandJson: serializeCornerBand(band),
				paramsJson: JSON.stringify(params),
			};
			const [row] = await db
				.update(records)
				.set({
					professionalJobStatus: "queued",
					professionalError: null,
					// Fresh manual retry → reset the reaper's auto-retry budget.
					professionalRetryCount: 0,
					updatedAt: new Date(),
				})
				.where(eq(records.id, id))
				.returning();
			await enqueueProfessionalMatte(id, stage);
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
					// Fresh source image → reset the reaper's auto-retry budget.
					professionalRetryCount: 0,
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

/**
 * Set a record's Discogs identity — a master (album) and/or a release (pressing) —
 * directly, without the full editor form. Backs the bulk "assign masters" / "fix
 * broken links" flow, which now offers both masters and releases per row: picking
 * a master sets the album link; picking a release sets the pressing link *and* its
 * parent master (or clears the master when the release is standalone). Only the
 * fields actually provided are touched — an `undefined` link is left alone, so a
 * master pick doesn't disturb an existing release and vice versa; a `null`
 * `masterId` (standalone release) explicitly clears the album link. Mirrors
 * {@link linkCopy}'s narrow update. Returns the updated row, or null if it vanished.
 */
export const assignRecordIdentity = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(
		(input: {
			id: number;
			// A master and/or a release. Nullable so a standalone release can clear the
			// master; `undefined` leaves that link untouched.
			masterId?: string | null;
			masterUrl?: string | null;
			discogsId?: string | null;
			discogsUrl?: string | null;
			// The picked candidate's album-level metadata, synced onto the row so it
			// matches what was linked (analysis-guessed fields otherwise read as a
			// mismatch in the editor).
			artist?: string;
			title?: string;
			year?: number | null;
			genre?: string | null;
		}) => input,
	)
	.handler(
		({ data: { id, masterId, masterUrl, discogsId, discogsUrl, ...meta } }) =>
			Sentry.startSpan({ name: "assignRecordIdentity" }, async () => {
				const db = getDb(env.DB);
				const now = new Date();
				const [row] = await db
					.update(records)
					.set({
						// Set a link only when provided. Re-linking is the fix for a broken
						// link, so clear the matching health flag and stamp the check
						// (optimistic — the cron re-validates and re-flags if the new link
						// is itself dead). `masterId` may be an explicit null (standalone
						// release), which clears the album link.
						...(masterId !== undefined
							? {
									masterId,
									masterUrl: masterUrl ?? null,
									masterMissing: false,
									masterCheckedAt: now,
								}
							: {}),
						...(discogsId !== undefined
							? {
									discogsId,
									discogsUrl: discogsUrl ?? null,
									releaseMissing: false,
									releaseCheckedAt: now,
								}
							: {}),
						// Sync album-level metadata; skip blanks so a real value isn't
						// clobbered with "".
						...(meta.artist ? { artist: meta.artist } : {}),
						...(meta.title ? { title: meta.title } : {}),
						...(meta.year != null ? { year: meta.year } : {}),
						...(meta.genre != null ? { genre: meta.genre } : {}),
						updatedAt: now,
					})
					.where(eq(records.id, id))
					.returning();
				return row ?? null;
			}),
	);

/**
 * Run the Discogs link-health check on demand from the admin UI, for the "Check
 * links" button. Same job the daily cron runs (validates a stalest-first batch of
 * masters + releases and updates the `*Missing` flags); this just makes it
 * admin-triggerable so a fresh check — and the resulting banner — is one click
 * away instead of a wait for the next scheduled pass or a manual cron POST.
 *
 * Uses the smaller {@link MANUAL_CHECK_BATCH}: the button awaits this inline, so a
 * full-size pass (~110s) would risk a request timeout. Repeated clicks walk the
 * stalest-first queue further. Returns the per-run tally so the button can report
 * what it found.
 */
export const checkLinkHealth = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(
		(): Promise<LinkHealthResult> => runLinkHealthCheck(MANUAL_CHECK_BATCH),
	);

/**
 * Kick off the matte-quality audit in the background, for the "Audit covers" action.
 * Unlike the synchronous "Check links", this doesn't block the request — a sweep over
 * the whole collection can run to many batches, so it self-chains through the queue
 * (see `stepMatteAuditSweep`/the `audit-mattes` mode in queue.ts) rather than the admin
 * waiting on one request. Progress (checked/suspects so far) is polled from
 * `listInFlight`, same as any other background job. Flags likely tint/edge-overrun
 * regressions — the same classes of bug the Parachutes matte fix addressed — for
 * records with a stale, bad render already baked into R2; purely diagnostic, flagged
 * rows still need a manual re-Apply or "Retry flagged mattes" to actually regenerate.
 * `beginMatteAuditSweep` atomically claims the sweep, so a second call while one is
 * already running (a race the client-side "already running" check can still lose —
 * another tab, a click before the poll catches up) is a no-op: `started: false` and
 * nothing gets enqueued, rather than starting a second chain that would corrupt the
 * shared checked/suspects counters.
 */
export const startMatteAuditSweep = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(async () => {
		const { started } = await beginMatteAuditSweep();
		if (started) await enqueueAuditMattes();
		return { started };
	});

/**
 * Link a record as an intentional duplicate copy of another — the admin "I own two
 * copies" action. Sets the current record's `copyOf` to the PRIMARY it's a copy of,
 * so it drops off the public collection and instead bumps the primary's "copies"
 * count. Keeps everything one level deep: linking to a record that is itself a copy
 * attaches to *its* primary, and if this record was itself a primary (had copies
 * pointing at it), those copies are reparented onto the new primary so none dangle.
 * Rejects self-links and the mirror link (A→B when B is already a copy of A).
 * Returns the updated (now-secondary) row, or null if it vanished.
 */
export const linkCopy = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((input: { id: number; copyOf: number }) => ({
		id: input.id,
		copyOf: input.copyOf,
	}))
	.handler(({ data: { id, copyOf } }) =>
		Sentry.startSpan({ name: "linkCopy" }, async () => {
			const db = getDb(env.DB);
			if (id === copyOf) {
				throw new Error("A record can't be a copy of itself.");
			}
			const [target] = await db
				.select({ id: records.id, copyOf: records.copyOf })
				.from(records)
				.where(eq(records.id, copyOf))
				.limit(1);
			if (!target) throw new Error("The record to link to no longer exists.");
			// Resolve to the root primary: linking to a secondary attaches to ITS
			// primary, so copies never chain more than one level deep.
			const primaryId = target.copyOf ?? target.id;
			if (primaryId === id) {
				// The target is already a copy of this record — linking the other way
				// would form a cycle. Unlink it first if you meant to flip the primary.
				throw new Error(
					"Those records are already linked the other way around.",
				);
			}
			const now = new Date();
			// If this record was itself a primary, reparent its copies onto the new
			// primary so nothing points at a row that's now a secondary.
			await db
				.update(records)
				.set({ copyOf: primaryId, updatedAt: now })
				.where(eq(records.copyOf, id));
			const [row] = await db
				.update(records)
				.set({ copyOf: primaryId, updatedAt: now })
				.where(eq(records.id, id))
				.returning();
			return row ?? null;
		}),
	);

/**
 * Unlink a copy — the inverse of {@link linkCopy}. Clears `copyOf`, promoting the
 * record back to a standalone entry (it reappears in the public collection if it's
 * otherwise publishable). Returns the updated row, or null if it's gone.
 */
export const unlinkCopy = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((id: number) => id)
	.handler(({ data: id }) =>
		Sentry.startSpan({ name: "unlinkCopy" }, async () => {
			const db = getDb(env.DB);
			const [row] = await db
				.update(records)
				.set({ copyOf: null, updatedAt: new Date() })
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
 * Look a release up by its printed barcode (UPC/EAN) — the exact-pressing fast
 * path for the unified search field and the Amazon importer. Validates/normalises
 * the barcode at the boundary; an unparseable one returns [] rather than erroring.
 * Genuine Discogs failures propagate so the UI can say why.
 */
export const searchDiscogsBarcode = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => {
		if (typeof data !== "string") throw new Error("Expected a barcode string");
		return data;
	})
	.handler(({ data: input }) =>
		Sentry.startSpan({ name: "searchDiscogsBarcode" }, () => {
			const barcode = parseBarcode(input);
			if (!barcode) return [];
			return searchByBarcode(barcode, MAX_PER_PAGE);
		}),
	);

/**
 * Resolve an Amazon ASIN to release facts (artist/title + barcode/year/label/…)
 * via web search, so the search field can accept a pasted ASIN. Returns null for
 * a non-ASIN input, or when web_search can't identify it — callers fall back to a
 * keyword search. The barcode in the result feeds `searchDiscogsBarcode` for an
 * exact match; the rest pre-fill the structured release filters.
 */
export const identifyAsin = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => {
		if (typeof data !== "string") throw new Error("Expected an ASIN string");
		return data;
	})
	.handler(({ data: input }) =>
		Sentry.startSpan({ name: "identifyAsin" }, () => {
			const asin = parseAsin(input);
			if (!asin) return null;
			return identifyFromAsin(asin);
		}),
	);

/**
 * Queue a batch of Amazon ASIN→pressing resolutions (the importer's "Queue
 * lookups"). Each job barcode-resolves one ASIN in the background and pins the
 * exact pressing on its record, so the slow per-ASIN web search never blocks the
 * modal. Ignores blanks; returns how many were actually enqueued.
 */
export const enqueueAmazonResolve = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(
		(data: Array<{ recordId: number; asin: string; country: string | null }>) =>
			data,
	)
	.handler(({ data: jobs }) =>
		Sentry.startSpan({ name: "enqueueAmazonResolve" }, async () => {
			const valid = jobs.filter(
				(j) => Number.isFinite(j.recordId) && parseAsin(j.asin),
			);
			if (valid.length > 0) await enqueueResolveAsinBatch(valid);
			return { queued: valid.length };
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
			// Deleting a primary promotes its linked copies back to standalone (they
			// reappear publicly) rather than pointing at a row that no longer exists.
			await db
				.update(records)
				.set({ copyOf: null, updatedAt: new Date() })
				.where(eq(records.copyOf, id));
			return { id };
		}),
	);

/** Validator shared by the bulk actions below: a plain list of record ids. */
const idList = (ids: number[]) => ids;

/**
 * Bulk delete. Removes every selected record in one statement and clears the
 * `copyOf` back-references in a second (promoting orphaned copies to standalone),
 * rather than issuing a request per row from the client. Returns how many ids were
 * targeted.
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
				// Promote copies of any deleted primary back to standalone.
				await db
					.update(records)
					.set({ copyOf: null, updatedAt: now })
					.where(inArray(records.copyOf, batch));
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
					// Fresh manual retry → reset the reaper's auto-retry budget.
					.set({
						status: "pending",
						error: null,
						analyzeRetryCount: 0,
						updatedAt: now,
					})
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
 * published — rows without an identity (`masterId` or `discogsId`) or an approved
 * cover/matte are silently skipped (a record needs both to be publishable), so the
 * count can be lower than the selection.
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
					// A record is only publishable once it has an identity (a master
					// album and/or a specific release) and an approved cover/matte to
					// display (see displayCoverKey).
					.where(
						and(
							inArray(records.id, batch),
							or(isNotNull(records.masterId), isNotNull(records.discogsId)),
							eq(records.professionalStatus, "approved"),
							isNotNull(records.professionalImageKey),
						),
					)
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
 * Bulk "Retry generation". Re-runs the full Apply pipeline (reframe + Real-ESRGAN enhance +
 * Magic matte) for every selected record that has a capture to generate from — mirroring the
 * per-record {@link reframeRecord} but keyed only by id (uses each row's stored corners +
 * tone). Only rows currently flagged `failed` with a capture are acted on — a mixed
 * selection's healthy rows are left untouched. Flips each to `queued`, clears the
 * error, resets the reaper's auto-retry budget, and enqueues in chunked `sendBatch` calls.
 * Leaves the display `professionalStatus` alone, so an already-approved cover stays live
 * until the fresh one swaps in. Returns how many were re-queued.
 */
export const retryProfessionalGenerations = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "retryProfessionalGenerations" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			const now = new Date();
			const requeued: number[] = [];
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.update(records)
					.set({
						professionalJobStatus: "queued",
						// Restart at stage 1 — mirrors the per-record reframeRecord so a row
						// that failed mid-stage-2 doesn't carry a stale "matte" marker.
						professionalStage: "cover",
						professionalError: null,
						professionalRetryCount: 0,
						updatedAt: now,
					})
					// Only the flagged-failed rows that have a capture to warp — a mixed
					// selection's healthy rows are left alone (no needless paid re-render).
					.where(
						and(
							inArray(records.id, batch),
							eq(records.professionalJobStatus, "failed"),
							isNotNull(records.capturePhotoKey),
						),
					)
					.returning({ id: records.id });
				requeued.push(...rows.map(({ id }) => id));
			}
			await enqueueProfessionalBatch(requeued);
			return { count: requeued.length };
		}),
	);

/**
 * Bulk "Retry Magic matte". Re-runs ONLY stage 2 (the Magic matte + commit) for every selected
 * record that has a live cover + its source capture — mirroring the per-record
 * {@link retryProfessionalMatte}, reconstructing each row's stage-1 snapshot so the re-cut
 * matte stays consistent with the live cover (which swaps in atomically only if the AI
 * matte lands). Skips the reframe + enhance the full pipeline would redo. Only rows on the
 * deterministic fallback with a cover + capture are acted on; everything else in the
 * selection is silently skipped. Returns how many were re-queued.
 */
export const retryProfessionalMattes = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "retryProfessionalMattes" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			const now = new Date();
			const items: Array<{ recordId: number; stage: CoverStageResult }> = [];
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.select()
					.from(records)
					.where(inArray(records.id, batch));
				for (const record of rows) {
					// Only rows actually on the deterministic fallback (what "Retry Magic matte"
					// upgrades) — a mixed selection's Magic-matte / no-matte rows are left alone.
					if (record.professionalAlphaSource !== "deterministic") continue;
					// Need a committed cover + its source capture to re-cut the matte from.
					if (!record.capturePhotoKey || !record.professionalImageKey) continue;
					const band = parseCornerBand(record.sleeveCornersJson);
					const params = parseReframeParams(record.professionalParamsJson);
					items.push({
						recordId: record.id,
						stage: {
							coverKey: record.professionalImageKey,
							enhanced: record.professionalEnhanced ?? false,
							captureKey: record.capturePhotoKey,
							bandJson: serializeCornerBand(band),
							paramsJson: JSON.stringify(params),
						},
					});
				}
			}
			if (items.length === 0) return { count: 0 };
			const byId = new Map(items.map((i) => [i.recordId, i]));
			// Re-apply the eligibility predicate in the UPDATE itself, atomically with the
			// flip — a row that changed between the SELECT above and this write (e.g. a
			// concurrent editor Apply that just landed a Magic matte, so it's no longer
			// `deterministic`) is skipped rather than blindly re-queued and re-enqueued from
			// a now-stale snapshot, which would clobber what that job produced. Enqueue only
			// the rows this UPDATE actually flipped (its returned ids).
			const flipped: number[] = [];
			for (const batch of chunk([...byId.keys()], D1_PARAM_CHUNK)) {
				const rows = await db
					.update(records)
					.set({
						professionalJobStatus: "queued",
						professionalError: null,
						professionalRetryCount: 0,
						updatedAt: now,
					})
					.where(
						and(
							inArray(records.id, batch),
							eq(records.professionalAlphaSource, "deterministic"),
							isNotNull(records.capturePhotoKey),
							isNotNull(records.professionalImageKey),
						),
					)
					.returning({ id: records.id });
				flipped.push(...rows.map(({ id }) => id));
			}
			const toEnqueue = flipped
				.map((id) => byId.get(id))
				.filter(
					(i): i is { recordId: number; stage: CoverStageResult } => i != null,
				);
			if (toEnqueue.length === 0) return { count: 0 };
			await enqueueProfessionalMatteBatch(toEnqueue);
			return { count: toEnqueue.length };
		}),
	);

/**
 * Bulk re-cut the matte for records the audit shortlisted with a fix-worthy reason (see
 * `hasMatteAuditFixReason` in photo-processing.ts — a `tint`-only result is a minor note,
 * not eligible here), regardless of `professionalAlphaSource` — unlike
 * {@link retryProfessionalMattes}, which only upgrades the deterministic fallback, an
 * audit-flagged row can perfectly well have come from the AI path (that's exactly the
 * edge-overrun/under-crop bug class this exists for). Only re-cuts rows still actually
 * flagged at write time (re-applies the eligibility predicate atomically with the flip,
 * same pattern as {@link retryProfessionalMattes}) and clears the flag so a clean result
 * isn't re-surfaced before the next audit sweep confirms it. Matte-only — reframe/enhance
 * are untouched, same division of labour as "Retry Magic matte".
 */
export const retryFlaggedMattes = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator(idList)
	.handler(({ data: ids }) =>
		Sentry.startSpan({ name: "retryFlaggedMattes" }, async () => {
			if (ids.length === 0) return { count: 0 };
			const db = getDb(env.DB);
			const now = new Date();
			const items: Array<{ recordId: number; stage: CoverStageResult }> = [];
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.select()
					.from(records)
					.where(inArray(records.id, batch));
				for (const record of rows) {
					if (!hasMatteAuditFixReason(record.professionalMatteAuditReason))
						continue;
					if (!record.capturePhotoKey || !record.professionalImageKey) continue;
					const band = parseCornerBand(record.sleeveCornersJson);
					const params = parseReframeParams(record.professionalParamsJson);
					items.push({
						recordId: record.id,
						stage: {
							coverKey: record.professionalImageKey,
							enhanced: record.professionalEnhanced ?? false,
							captureKey: record.capturePhotoKey,
							bandJson: serializeCornerBand(band),
							paramsJson: JSON.stringify(params),
						},
					});
				}
			}
			if (items.length === 0) return { count: 0 };
			const byId = new Map(items.map((i) => [i.recordId, i]));
			const flipped: number[] = [];
			for (const batch of chunk([...byId.keys()], D1_PARAM_CHUNK)) {
				const rows = await db
					.update(records)
					.set({
						professionalJobStatus: "queued",
						professionalError: null,
						professionalRetryCount: 0,
						updatedAt: now,
					})
					.where(
						and(
							inArray(records.id, batch),
							isNotNull(records.professionalMatteAuditReason),
							isNotNull(records.capturePhotoKey),
							isNotNull(records.professionalImageKey),
						),
					)
					.returning({ id: records.id });
				flipped.push(...rows.map(({ id }) => id));
			}
			const toEnqueue = flipped
				.map((id) => byId.get(id))
				.filter(
					(i): i is { recordId: number; stage: CoverStageResult } => i != null,
				);
			if (toEnqueue.length === 0) return { count: 0 };
			await enqueueProfessionalMatteBatch(toEnqueue);
			return { count: toEnqueue.length };
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
			// Every record has something to refresh or guess a master from (artist is
			// NOT NULL), so enqueue all selected rows that still exist. The select just
			// drops ids deleted between selection and now; the consumer no-ops on any
			// row it can't act on.
			const existing: number[] = [];
			for (const batch of chunk(ids, D1_PARAM_CHUNK)) {
				const rows = await db
					.select({ id: records.id })
					.from(records)
					.where(inArray(records.id, batch));
				existing.push(...rows.map(({ id }) => id));
			}
			await enqueueRefreshBatch(existing);
			return { count: existing.length };
		}),
	);
