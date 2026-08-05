import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { asc, eq, isNotNull } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { assessMatteQuality } from "#/lib/photo-processing";
import { decodeRgba } from "#/lib/professional";

/**
 * How many stored mattes to re-check per sweep. Each row costs one R2 GET + a small
 * Images-binding downsize + a cheap pixel scan (no model calls), so this is bounded by
 * the request/gateway timeout the same way {@link MANUAL_CHECK_BATCH} bounds the Discogs
 * link-health check, not by any external rate limit — see `master-health.ts`. Rows are
 * swept stalest-first (never-audited rows lead), so a full collection sweep just takes a
 * few clicks; a fresh matte resets its own `CheckedAt` to null (see
 * `professional-pipeline.ts`), so it naturally rejoins the front of the queue.
 */
export const MATTE_AUDIT_BATCH = 40;

/** Downsize target for the audit scan — the heuristics only need coarse pixel stats, so
 * this stays far below the ~2400px stored matte to keep the decode cheap. */
const AUDIT_DECODE_SIZE = 256;

export type MatteAuditTally = {
	checked: number;
	suspects: number;
};

/**
 * Sweep a stalest-first batch of professional records with a stored matte, scoring each
 * with {@link assessMatteQuality} and persisting the result. Cheap and model-free — this
 * is a shortlist tool for the admin "Audit covers" action, not a fix: flagged records
 * still need a manual re-Apply / "Retry Magic matte" to actually regenerate.
 */
export async function runMatteAudit(
	limit: number = MATTE_AUDIT_BATCH,
): Promise<MatteAuditTally> {
	return Sentry.startSpan({ name: "runMatteAudit" }, async () => {
		const db = getDb(env.DB);

		// Stalest-first, same as the link-health sweep: SQLite sorts NULLs before
		// non-NULLs under ASC, so never-audited rows (including freshly-regenerated
		// ones) lead, then the least-recently checked.
		const due = await db
			.select({
				id: records.id,
				cutoutKey: records.professionalAlphaCutoutKey,
			})
			.from(records)
			.where(isNotNull(records.professionalAlphaCutoutKey))
			.orderBy(asc(records.professionalMatteAuditCheckedAt))
			.limit(limit);

		let suspects = 0;
		for (const row of due) {
			if (!row.cutoutKey) continue;
			const object = await env.PHOTOS.get(row.cutoutKey);
			const now = new Date();
			if (!object) {
				// Stale key (R2 object gone) — mark checked so it doesn't jam the front of
				// the stalest-first queue, but leave it unflagged; that's a data-integrity
				// issue for something else to catch, not a matte-quality one.
				await db
					.update(records)
					.set({
						professionalMatteAuditCheckedAt: now,
						professionalMatteAuditReason: null,
					})
					.where(eq(records.id, row.id));
				continue;
			}
			try {
				const out = await env.IMAGES.input(object.body)
					.transform({
						width: AUDIT_DECODE_SIZE,
						height: AUDIT_DECODE_SIZE,
						fit: "scale-down",
					})
					.output({ format: "image/webp", quality: 92 });
				const rgba = decodeRgba(
					new Uint8Array(await out.response().arrayBuffer()),
				);
				const assessment = assessMatteQuality(rgba);
				const reasons = [
					assessment.tintSuspect ? "tint" : null,
					assessment.edgeSuspect ? "edge" : null,
				].filter((r): r is string => r != null);
				if (reasons.length > 0) suspects++;
				await db
					.update(records)
					.set({
						professionalMatteAuditCheckedAt: now,
						professionalMatteAuditReason: reasons.length
							? reasons.join(",")
							: null,
					})
					.where(eq(records.id, row.id));
			} catch (error) {
				// A transient R2/Images blip or a genuinely corrupt stored cutout — either
				// way, don't let one bad row abort the whole sweep. Unlike the "gone"
				// branch above, leave checkedAt untouched (same as an inconclusive result
				// in master-health.ts's sweep): a decode failure is itself a strong
				// bad-matte signal, so the row stays at the front of the stalest-first
				// queue and gets retried next run instead of parking as "audited, clean".
				Sentry.captureException(error);
			}
		}

		return { checked: due.length, suspects };
	});
}
