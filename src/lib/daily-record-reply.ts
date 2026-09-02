import { eq } from "drizzle-orm";
import TurndownService from "turndown";

import { getDb } from "#/db";
import { records } from "#/db/schema";

/**
 * Inbound half of the daily-record-email flow (see src/lib/daily-record.ts):
 * a reply to `record-<id>@reply.records.charliegleason.com` replaces that
 * record's notes with the reply's body, converted to markdown. Wired up as a
 * Mailgun inbound route webhook (src/routes/api/inbound.daily-record.ts) —
 * Cloudflare Email Routing can't be scoped below a zone's apex, which would
 * mean taking over charliegleason.com's real MX (currently Gmail), so a
 * dedicated MX + Mailgun route on the reply subdomain handles receiving
 * instead. Mailgun's `stripped-text`/`stripped-html` fields already exclude
 * the quoted reply chain, so no quote-stripping is done here.
 */

const OWNER_EMAIL = "hi@charliegleason.com";
const RECORD_ADDRESS = /^record-(\d+)@/i;

const turndown = new TurndownService();

async function verifyMailgunSignature(
	timestamp: string,
	token: string,
	signature: string,
	signingKey: string,
): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(signingKey),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(timestamp + token),
	);
	const hex = [...new Uint8Array(mac)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	if (hex.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < hex.length; i++) {
		diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
	}
	return diff === 0;
}

function field(formData: FormData, name: string): string {
	return formData.get(name)?.toString().trim() ?? "";
}

/**
 * The HMAC signature only proves the request came from Mailgun's relay, not
 * who sent the underlying email — `sender`/`From:` are trivially spoofable.
 * Mailgun runs its own SPF/DKIM checks on inbound mail and appends the
 * verdicts as headers (`X-Mailgun-Spf`, `X-Mailgun-Dkim-Check-Result`) on the
 * message it hands back, surfaced here via `message-headers`.
 */
function messageHeader(formData: FormData, name: string): string | undefined {
	const raw = field(formData, "message-headers");
	if (!raw) return undefined;
	try {
		const headers = JSON.parse(raw) as [string, string][];
		return headers.find(
			([key]) => key.toLowerCase() === name.toLowerCase(),
		)?.[1];
	} catch {
		return undefined;
	}
}

export async function handleDailyRecordReply(
	formData: FormData,
	env: Cloudflare.Env,
): Promise<{ ok: boolean; reason?: string }> {
	const signingKey = env.MAILGUN_WEBHOOK_SIGNING_KEY;
	if (!signingKey) return { ok: false, reason: "webhook not configured" };

	const timestamp = field(formData, "timestamp");
	const token = field(formData, "token");
	const signature = field(formData, "signature");
	const verified = await verifyMailgunSignature(
		timestamp,
		token,
		signature,
		signingKey,
	);
	if (!verified) return { ok: false, reason: "invalid signature" };

	const sender = field(formData, "sender").toLowerCase();
	if (sender !== OWNER_EMAIL) return { ok: false, reason: "not authorized" };

	const spf = messageHeader(formData, "X-Mailgun-Spf");
	const dkim = messageHeader(formData, "X-Mailgun-Dkim-Check-Result");
	if (spf !== "Pass" || dkim !== "Pass") {
		return { ok: false, reason: "sender authentication failed" };
	}

	const recipient = field(formData, "recipient");
	const match = RECORD_ADDRESS.exec(recipient);
	if (!match) return { ok: false, reason: "unknown record address" };
	const recordId = Number(match[1]);

	const strippedText = field(formData, "stripped-text");
	const strippedHtml = field(formData, "stripped-html");
	const notes =
		strippedText || (strippedHtml ? turndown.turndown(strippedHtml) : "");
	if (!notes) return { ok: false, reason: "empty reply body" };

	const db = getDb(env.DB);
	await db.update(records).set({ notes }).where(eq(records.id, recordId));

	return { ok: true };
}
