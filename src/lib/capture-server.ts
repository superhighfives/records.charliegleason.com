import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { type Record as RecordRow, records } from "#/db/schema";
import { DEFAULT_COLOR_NAME, getOrCreateColor } from "#/lib/colors";
import { enqueueAnalyze, enqueueCaptureFirstPass } from "#/lib/queue";

/**
 * Server-only capture creation/replacement, called by `/api/admin/capture`
 * after it streams the photo into R2. Deliberately NOT in `records.ts` and NOT
 * server fns: the base64-in-JSON server-fn payloads they replace held ~6 copies
 * of the photo in the isolate and blew the 128 MB memory limit on unshrunk
 * originals (and as plain exports in a module client routes import, the
 * TanStack compiler couldn't strip them from the browser bundle).
 *
 * Both flows stay light on purpose: the photon-heavy first-pass professional
 * photo runs as its own queue message (`runCaptureFirstPass`), never inline in
 * the request isolate — see that module for the OOM story.
 */

/** Flag the professional* track failed when the first-pass can't even enqueue. */
async function markFirstPassUnqueued(
	recordId: number,
	err: unknown,
): Promise<RecordRow | null> {
	const detail = err instanceof Error ? err.message : String(err);
	const db = getDb(env.DB);
	const [failed] = await db
		.update(records)
		.set({
			professionalStatus: "failed",
			professionalError: `Could not queue professional photo: ${detail}`,
			updatedAt: new Date(),
		})
		.where(eq(records.id, recordId))
		.returning()
		.catch(() => []);
	return failed ?? null;
}

/**
 * Capture flow entry: insert a `pending` row for an already-stored capture photo
 * and enqueue it for background analysis + the first-pass professional photo.
 * Returns the new row so the UI can jump straight to its detail page and watch
 * the AI work land.
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

		// First-pass professional photo (detect corners, warp, deterministic
		// matte) — its own queue message, best-effort and fully independent of
		// analysis: an enqueue failure marks the professional* track (a manual
		// re-crop retries) rather than failing the whole capture.
		try {
			await enqueueCaptureFirstPass(row.id);
		} catch (err) {
			return (await markFirstPassUnqueued(row.id, err)) ?? row;
		}
		return row;
	});
}

/**
 * Swap a record's source capture for a freshly uploaded photo, then regenerate
 * the first-pass professional crop from it via the same queue message — clearing
 * the stored corners first so the pass re-detects the sleeve (they were for the
 * old image). The regenerated result lands back as `ready` (unapproved), so the
 * admin re-approves via the editor. Best-effort R2 cleanup of the superseded
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

		const [row] = await db
			.update(records)
			.set({
				capturePhotoKey,
				// The old professional cover/matte were cut from the old capture (and
				// their objects are deleted below) — clear them so nothing points at a
				// deleted R2 object while the first-pass regenerates.
				professionalImageKey: null,
				professionalAlphaKey: null,
				professionalAlphaCutoutKey: null,
				professionalAlphaSource: null,
				professionalStatus: null,
				professionalError: null,
				// Stored corners were for the old image — clear so the pass re-detects.
				sleeveCornersJson: null,
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
			if (staleKey && staleKey !== capturePhotoKey) {
				await env.PHOTOS.delete(staleKey).catch(() => {});
			}
		}

		try {
			await enqueueCaptureFirstPass(id);
		} catch (err) {
			return (await markFirstPassUnqueued(id, err)) ?? row ?? null;
		}
		return row ?? null;
	});
}
