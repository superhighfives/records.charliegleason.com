import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { runWeeklyDigest } from "#/lib/digest";

/**
 * Manual / external trigger for the weekly digest, guarded by a shared secret
 * (`x-cron-secret`). The cron trigger calls runWeeklyDigest() directly via the
 * scheduled handler (src/server.ts); this route is for testing and re-runs.
 */
export const Route = createFileRoute("/api/cron/digest")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const secret = request.headers.get("x-cron-secret");
				if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
					return json({ error: "unauthorized" }, { status: 401 });
				}
				const result = await runWeeklyDigest();
				return json(result);
			},
		},
	},
});
