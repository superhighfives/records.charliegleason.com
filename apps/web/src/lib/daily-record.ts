import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { eq, isNull, or, sql } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";

/**
 * Daily "record of the day" email: picks one record without notes yet and emails
 * it, with a per-record Reply-To address so a plain reply lands back as that
 * record's notes (see src/lib/daily-record-reply.ts). Driven by the cron trigger
 * (see src/server.ts) or the protected /api/cron/daily-record route.
 */

const FROM = { name: "Records Daily", email: "digest@charliegleason.com" };
const TO = "hi@charliegleason.com";
export const REPLY_DOMAIN = "reply.records.charliegleason.com";

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function renderHtml(record: {
	artist: string;
	title: string;
	year: number | null;
}): string {
	const meta = record.year ? `${record.year}` : "";
	return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h1 style="font-size:18px">${escapeHtml(record.artist)} — ${escapeHtml(record.title)}</h1>
  <p style="color:#888;font-size:13px">${escapeHtml(meta)}</p>
  <p style="color:#666;font-size:14px">Reply to this email to add it as this record's notes.</p>
  <p style="color:#aaa;font-size:12px">records.charliegleason.com</p>
</body></html>`;
}

function renderText(record: {
	artist: string;
	title: string;
	year: number | null;
}): string {
	const meta = record.year ? ` (${record.year})` : "";
	return `${record.artist} — ${record.title}${meta}\n\nReply to this email to add it as this record's notes.`;
}

export function runDailyRecordPick(): Promise<{
	sent: boolean;
	recordId?: number;
}> {
	return Sentry.startSpan({ name: "runDailyRecordPick" }, async () => {
		const db = getDb(env.DB);

		// Never-featured, notes-empty records first — once every candidate has
		// been sent at least once, fall back to the full notes-empty set so it's
		// fine (and expected) to repeat.
		const neverFeatured = await db
			.select({
				id: records.id,
				artist: records.artist,
				title: records.title,
				year: records.year,
			})
			.from(records)
			.where(
				sql`(${records.notes} IS NULL OR ${records.notes} = '') AND ${records.dailyPickEmailedAt} IS NULL`,
			)
			.orderBy(sql`RANDOM()`)
			.limit(1);

		const [record] =
			neverFeatured.length > 0
				? neverFeatured
				: await db
						.select({
							id: records.id,
							artist: records.artist,
							title: records.title,
							year: records.year,
						})
						.from(records)
						.where(or(isNull(records.notes), sql`${records.notes} = ''`))
						.orderBy(sql`RANDOM()`)
						.limit(1);

		if (!record) return { sent: false };

		// `send_email` isn't bound in the preview env, so the binding is optional.
		// The daily pick only runs via cron/route in production, where it's
		// present — surface a clear error if it's ever invoked somewhere it isn't.
		if (!env.EMAIL) {
			throw new Error("EMAIL binding is not configured in this environment");
		}

		await env.EMAIL.send({
			from: FROM,
			to: TO,
			replyTo: `record-${record.id}@${REPLY_DOMAIN}`,
			subject: `Record of the day: ${record.artist} — ${record.title}`,
			html: renderHtml(record),
			text: renderText(record),
		});

		await db
			.update(records)
			.set({ dailyPickEmailedAt: new Date() })
			.where(eq(records.id, record.id));

		return { sent: true, recordId: record.id };
	});
}
