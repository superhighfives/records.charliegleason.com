import { EmailMessage } from "cloudflare:email";
import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createMimeMessage } from "mimetext";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { getTopAlbums, type LastfmAlbum } from "#/lib/lastfm";

/**
 * Daily "records to buy" digest: top Last.fm albums you don't already own,
 * emailed via the Cloudflare Email (`EMAIL`) binding. Driven by the cron trigger
 * (see src/server.ts) or the protected /api/cron/digest route.
 */

const FROM = "digest@records.charliegleason.com";
const TO = "hi@charliegleason.com";

function normalize(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Top recent albums from Last.fm that aren't already in the collection. */
export async function buildSuggestions(
	limit = 10,
): Promise<Array<LastfmAlbum>> {
	const db = getDb(env.DB);
	const [albums, owned] = await Promise.all([
		getTopAlbums("1month", 50).catch(() => []),
		db.select({ artist: records.artist, title: records.title }).from(records),
	]);

	const ownedKeys = new Set(
		owned.map((r) => `${normalize(r.artist)}|${normalize(r.title)}`),
	);
	return albums
		.filter(
			(a) => !ownedKeys.has(`${normalize(a.artist)}|${normalize(a.title)}`),
		)
		.slice(0, limit);
}

function renderHtml(suggestions: Array<LastfmAlbum>): string {
	const items = suggestions
		.map(
			(s) => `<li style="margin:0 0 12px">
  <a href="${escapeHtml(s.url)}" style="color:#111;text-decoration:none;font-weight:600">${escapeHtml(s.artist)} — ${escapeHtml(s.title)}</a>
  <span style="color:#888"> · ${s.playcount} plays this month</span>
</li>`,
		)
		.join("");

	return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h1 style="font-size:18px">Records to consider</h1>
  <p style="color:#666;font-size:14px">From your Last.fm listening this month, minus what you already own.</p>
  <ul style="list-style:none;padding:0">${items}</ul>
  <p style="color:#aaa;font-size:12px">records.charliegleason.com</p>
</body></html>`;
}

export function runDailyDigest(): Promise<{ sent: boolean; count: number }> {
	return Sentry.startSpan({ name: "runDailyDigest" }, async () => {
		const suggestions = await buildSuggestions(10);
		if (suggestions.length === 0) return { sent: false, count: 0 };

		const msg = createMimeMessage();
		msg.setSender({ name: "Records", addr: FROM });
		msg.setRecipient(TO);
		msg.setSubject(`${suggestions.length} records to consider`);
		msg.addMessage({ contentType: "text/html", data: renderHtml(suggestions) });

		await env.EMAIL.send(new EmailMessage(FROM, TO, msg.asRaw()));
		return { sent: true, count: suggestions.length };
	});
}
