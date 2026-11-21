import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { runDailyRecordPick } from "#/lib/daily-record";
import { runWeeklyDigest } from "#/lib/digest";
import { runLinkHealthCheck } from "#/lib/master-health";

// The cron triggers call these directly from the scheduled handler
// (src/server.ts). This route is for testing and re-runs.
const JOBS: Record<string, () => Promise<unknown>> = {
	"daily-record": runDailyRecordPick,
	digest: runWeeklyDigest,
	// Path kept as `master-check` for URL stability; it checks releases too.
	"master-check": runLinkHealthCheck,
};

/**
 * Manual trigger for a scheduled job, guarded by a shared secret
 * (`x-cron-secret`). `POST /api/cron/<job>` runs the job and returns its result.
 */
export const Route = createFileRoute("/api/cron/$job")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const secret = request.headers.get("x-cron-secret");
				if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
					return json({ error: "unauthorized" }, { status: 401 });
				}
				const run = Object.hasOwn(JOBS, params.job) ? JOBS[params.job] : null;
				if (!run) return json({ error: "unknown job" }, { status: 404 });
				return json(await run());
			},
		},
	},
});
