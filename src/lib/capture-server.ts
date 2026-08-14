import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record as RecordRow, records } from "#/db/schema";
import { DEFAULT_COLOR_NAME, getOrCreateColor } from "#/lib/colors";
import { generateMatteFromCapture } from "#/lib/matte";
import { professionalPipeline } from "#/lib/professional";
import { enqueueAnalyze } from "#/lib/queue";
import { parseReframeParams } from "#/lib/reframe-params";
import { DEFAULT_BAND, serializeCornerBand } from "#/lib/sleeve-corners";

/**
 * Server-only capture creation/replacement, called by `/api/admin/capture`
 * after it streams the photo into R2. Deliberately NOT in `records.ts` and NOT
 * server fns: as plain exports in a module that client routes import, the
 * TanStack compiler can't strip them from the browser bundle, and their
 * `professionalPipeline` dependency drags the photon wasm into the client
 * build (which fails). The base64-in-JSON server-fn payloads they replace held
 * ~6 copies of the photo in the isolate and blew the 128 MB memory limit on
 * unshrunk originals.
 */

/**
 * Capture flow entry: insert a `pending` row for an already-stored capture photo
 * and enqueue it for background analysis. Returns the new row so the UI can jump
 * straight to its detail page and watch the AI work land.
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
 * Swap a record's source capture for a freshly uploaded photo, then regenerate the
 * first-pass professional crop from it — re-detecting the sleeve, since the stored
 * corners were for the old image. The result drops back to `ready` (unapproved), so
 * the admin re-approves via the editor. Best-effort R2 cleanup of the superseded
 * capture + professional objects. Returns the updated row, or null if it's gone.
 */
export function replaceCaptureRecord(
	id: number,
	capturePhotoKey: string,
): Promise<RecordRow | null> {
	return Sentry.startSpan({ name: "replaceCapture" }, async () => {
		const db = getDb(env.DB);
		const [record] = await db
			.select()
			.from(records)
			.where(eq(records.id, id))
			.limit(1);
		if (!record) return null;

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
	});
}
