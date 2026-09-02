import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { runDailyRecordPick } from "#/lib/daily-record";

/**
 * Manual / external trigger for the daily record-of-the-day email, guarded by
 * a shared secret (`x-cron-secret`). The cron trigger calls runDailyRecordPick()
 * directly via the scheduled handler (src/server.ts); this route is for testing
 * and re-runs.
 */
export const Route = createFileRoute("/api/cron/daily-record")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const secret = request.headers.get("x-cron-secret");
				if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
					return json({ error: "unauthorized" }, { status: 401 });
				}
				const result = await runDailyRecordPick();
				return json(result);
			},
		},
	},
});
