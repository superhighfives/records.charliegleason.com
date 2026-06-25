import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { getTopAlbums, type LastfmAlbum } from "#/lib/lastfm";
import { findCheapestVinyl, type SellerSummary } from "#/lib/sellers";

/**
 * Daily "records to buy" digest: top Last.fm albums you don't already own,
 * emailed via the Cloudflare Email Sending (`EMAIL`) binding. Driven by the cron
 * trigger (see src/server.ts) or the protected /api/cron/digest route. `FROM` must
 * be on the domain onboarded for Email Sending (apex, not the worker subdomain).
 */

const FROM = "digest@charliegleason.com";
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

/** Albums to suggest, each with its cheapest-to-buy offer (null if unavailable). */
type Suggestion = LastfmAlbum & { offer: SellerSummary | null };

function formatPrice(value: number): string {
	return `$${value.toFixed(2)}`;
}

/**
 * One subtle line under a suggestion describing the cheapest place to buy it on
 * vinyl, by total cost incl. shipping. Returns "" when no pricing is available.
 */
function renderOffer(offer: SellerSummary | null): string {
	if (!offer) return "";
	const { cheapest, offerCount } = offer;

	let cost: string;
	if (cheapest.freeShipping) {
		cost = `${formatPrice(cheapest.itemPrice)} with free shipping`;
	} else if (cheapest.shippingPrice && cheapest.shippingPrice > 0) {
		cost = `${formatPrice(cheapest.totalPrice)} incl. shipping`;
	} else {
		cost = `${formatPrice(cheapest.itemPrice)} + shipping`;
	}

	const sellers = offerCount > 1 ? ` · ${offerCount} sellers` : "";
	const label = `From ${cost} at ${escapeHtml(cheapest.seller)}${sellers}`;

	return `
  <a href="${escapeHtml(cheapest.url)}" style="display:block;margin-top:2px;color:#aaa;text-decoration:none;font-size:13px">${label}</a>`;
}

function renderHtml(suggestions: Array<Suggestion>): string {
	const items = suggestions
		.map(
			(s) => `<li style="margin:0 0 12px">
  <a href="${escapeHtml(s.url)}" style="color:#111;text-decoration:none;font-weight:600">${escapeHtml(s.artist)} — ${escapeHtml(s.title)}</a>
  <span style="color:#888"> · ${s.playcount} plays this month</span>${renderOffer(s.offer)}
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
		const albums = await buildSuggestions(10);
		if (albums.length === 0) return { sent: false, count: 0 };

		// Enrich each suggestion with its cheapest vinyl offer. Lookups are
		// independent and individually failure-tolerant (null on any problem), so
		// run them together — a slow or missing price never blocks the others.
		const suggestions: Array<Suggestion> = await Promise.all(
			albums.map(async (a) => ({
				...a,
				offer: await findCheapestVinyl(a.artist, a.title),
			})),
		);

		// `send_email` isn't bound in the preview env, so the binding is optional.
		// The digest only runs via cron/route in production, where it's present —
		// surface a clear error if it's ever invoked somewhere it isn't.
		if (!env.EMAIL) {
			throw new Error("EMAIL binding is not configured in this environment");
		}

		await env.EMAIL.send({
			from: FROM,
			to: TO,
			subject: `${suggestions.length} records to consider`,
			html: renderHtml(suggestions),
		});
		return { sent: true, count: suggestions.length };
	});
}
