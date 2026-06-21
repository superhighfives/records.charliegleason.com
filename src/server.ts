import entry from "@tanstack/react-start/server-entry";

import { runDailyDigest } from "#/lib/digest";

/**
 * Worker entry. Wraps TanStack Start's default fetch handler and adds a
 * `scheduled` (cron) handler for the daily digest. wrangler.jsonc `main` points
 * here; the cron schedule is in wrangler.jsonc `triggers.crons`.
 */
export default {
	fetch: entry.fetch,
	scheduled(
		_controller: ScheduledController,
		_env: unknown,
		ctx: ExecutionContext,
	) {
		ctx.waitUntil(runDailyDigest());
	},
};
