import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { getTopAlbums, type LastfmAlbum } from "#/lib/lastfm";
import { findCheapestVinyl, type SellerSummary } from "#/lib/sellers";

/**
 * Weekly "records to buy" digest: top Last.fm albums you don't already own,
 * emailed via the Cloudflare Email Sending (`EMAIL`) binding. Driven by the cron
 * trigger (see src/server.ts) or the protected /api/cron/digest route. `FROM` must
 * be on the domain onboarded for Email Sending (apex, not the worker subdomain).
 */

const FROM = { name: "Records Weekly", email: "digest@charliegleason.com" };
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
		getTopAlbums("7day", 50).catch(() => []),
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

/** Phrase an offer's price with what we know about its shipping. */
function formatCost(offer: {
	itemPrice: number;
	totalPrice: number;
	shippingPrice: number | null;
	freeShipping: boolean;
}): string {
	if (offer.freeShipping)
		return `${formatPrice(offer.itemPrice)} with free shipping`;
	if (offer.shippingPrice && offer.shippingPrice > 0) {
		return `${formatPrice(offer.totalPrice)} incl. shipping`;
	}
	return `${formatPrice(offer.itemPrice)} + shipping`;
}

/** A small pill showing how many qualifying vinyl sellers were found. */
function renderBadge(count: number): string {
	const label = `${count} ${count === 1 ? "seller" : "sellers"}`;
	return ` <span style="display:inline-block;background:#f0f0f0;color:#888;border-radius:9px;padding:0 7px;font-size:11px;line-height:18px;vertical-align:middle">${label}</span>`;
}

/**
 * The "where to buy" block under a suggestion: preferred shops first, each in the
 * prominent title text color — Amazon Prime, then Plaid Room Records — followed by
 * the cheapest vinyl seller line in muted grey (with a sellers badge). Returns ""
 * when no pricing is available.
 */
function renderOffer(offer: SellerSummary | null): string {
	if (!offer) return "";
	const { cheapest, offerCount, prime, plaidRoom } = offer;

	let html = "";

	// Preferred shops, rendered in the dark title colour so they stand out.
	const preferred: Array<{ label: string; url: string }> = [];
	if (prime) {
		preferred.push({
			label: `Amazon Prime · ${formatCost(prime)}`,
			url: prime.url,
		});
	}
	if (plaidRoom) {
		preferred.push({
			label: `Plaid Room Records · ${formatCost(plaidRoom)}`,
			url: plaidRoom.url,
		});
	}
	preferred.forEach((line, i) => {
		html += `
  <a href="${escapeHtml(line.url)}" style="display:block;margin-top:${i === 0 ? "2px" : "1px"};color:#111;text-decoration:none;font-size:13px">${line.label}</a>`;
	});

	const main = `From ${formatCost(cheapest)} at ${escapeHtml(cheapest.seller)}`;
	html += `
  <a href="${escapeHtml(cheapest.url)}" style="display:block;margin-top:${preferred.length ? "1px" : "2px"};color:#aaa;text-decoration:none;font-size:13px">${main}${renderBadge(offerCount)}</a>`;

	return html;
}

function renderHtml(suggestions: Array<Suggestion>): string {
	const items = suggestions
		.map(
			(s) => `<li style="margin:0 0 12px">
  <a href="${escapeHtml(s.url)}" style="color:#111;text-decoration:none;font-weight:600">${escapeHtml(s.artist)} — ${escapeHtml(s.title)}</a>
  <span style="color:#888"> · ${s.playcount} plays this week</span>${renderOffer(s.offer)}
</li>`,
		)
		.join("");

	return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h1 style="font-size:18px">Records to consider</h1>
  <p style="color:#666;font-size:14px">From your Last.fm listening this week, minus what you already own.</p>
  <ul style="list-style:none;padding:0">${items}</ul>
  <p style="color:#aaa;font-size:12px">records.charliegleason.com</p>
</body></html>`;
}

export function runWeeklyDigest(): Promise<{ sent: boolean; count: number }> {
	return Sentry.startSpan({ name: "runWeeklyDigest" }, async () => {
		const albums = await buildSuggestions(10);
		if (albums.length === 0) return { sent: false, count: 0 };

		// Enrich each suggestion with its cheapest vinyl offer. Lookups are
		// independent and individually failure-tolerant (null on any problem), so
		// run them together — a slow or missing price never blocks the others.
		const enriched: Array<Suggestion> = await Promise.all(
			albums.map(async (a) => ({
				...a,
				offer: await findCheapestVinyl(a.artist, a.title),
			})),
		);

		// Only email records we can actually point at a vinyl to buy. An album with
		// no qualifying offer (no pressing for sale, or the lookup came back empty)
		// would otherwise render as a bare title with no "where to buy" line.
		const suggestions = enriched.filter((s) => s.offer !== null);
		if (suggestions.length === 0) return { sent: false, count: 0 };

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
