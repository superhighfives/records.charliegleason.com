import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { handleDailyRecordReply } from "#/lib/daily-record-reply";

/**
 * Mailgun inbound route webhook for the daily-record reply flow (see
 * src/lib/daily-record.ts / daily-record-reply.ts). Mailgun POSTs
 * multipart/form-data here for anything matching its route on
 * reply.records.charliegleason.com. Verified via Mailgun's HMAC webhook
 * signature (timestamp/token/signature fields), not the shared cron secret.
 * Always returns 200 on a handled-but-rejected message (bad signature, wrong
 * sender, unknown address) so Mailgun doesn't retry — only a genuine server
 * error should trigger a retry.
 */
export const Route = createFileRoute("/api/inbound/daily-record")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const formData = await request.formData();
				const result = await handleDailyRecordReply(formData, env);
				return json(result);
			},
		},
	},
});
