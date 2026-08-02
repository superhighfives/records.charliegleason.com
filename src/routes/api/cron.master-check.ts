import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { runLinkHealthCheck } from "#/lib/master-health";

/**
 * Manual / external trigger for the Discogs link-health check (masters +
 * releases), guarded by a shared secret (`x-cron-secret`). The cron trigger calls
 * runLinkHealthCheck() directly via the scheduled handler (src/server.ts); this
 * route is for testing and re-runs (e.g. after re-linking a batch of records, to
 * clear their flags immediately rather than waiting for the next scheduled pass).
 * Mirrors /api/cron/digest. Path kept as `master-check` for URL stability.
 */
export const Route = createFileRoute("/api/cron/master-check")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const secret = request.headers.get("x-cron-secret");
				if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
					return json({ error: "unauthorized" }, { status: 401 });
				}
				const result = await runLinkHealthCheck();
				return json(result);
			},
		},
	},
});
