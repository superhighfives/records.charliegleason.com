import * as Sentry from "@sentry/cloudflare";
import entry from "@tanstack/react-start/server-entry";

import { runDailyRecordPick } from "#/lib/daily-record";
import { runWeeklyDigest } from "#/lib/digest";
import { pruneJobEvents } from "#/lib/job-events";
import { runLinkHealthCheck } from "#/lib/master-health";
import { isMonthlyRefreshDay } from "#/lib/value";

const LINK_CHECK_CRON = "0 9 * * *";
const DAILY_RECORD_CRON = "0 13 * * *";

import {
	type AnalyzeMessage,
	handleAnalyzeBatch,
	refreshAllValues,
} from "#/lib/queue";

/**
 * Worker entry. Wraps TanStack Start's default fetch handler, adds a `scheduled`
 * (cron) handler — the weekly digest and the daily master-link health check,
 * dispatched by cron expression — and a `queue` consumer for background
 * record analysis, and instruments the whole thing with Sentry on the Workers
 * runtime via `withSentry` (covers fetch, scheduled and queue, and powers the
 * `Sentry.startSpan` calls in server functions). Needs `nodejs_compat`
 * (AsyncLocalStorage) — set in wrangler.jsonc.
 */
const handler: ExportedHandler<Cloudflare.Env> = {
	// TanStack's handler takes (request); env/ctx are reached via cloudflare:workers.
	fetch: (request) => entry.fetch(request),
	// Three crons share this handler (see wrangler.jsonc `triggers.crons`) — dispatch
	// by the cron expression that fired. The daily link-check validates Discogs
	// master + release links and prunes the Activity log; the daily record-pick
	// emails one notes-empty record (see src/lib/daily-record.ts) and, on the first
	// of the month, re-prices the collection; the weekly slot runs the buy digest.
	// The re-pricing rides on the record-pick slot because that one makes no
	// Discogs calls, so the two don't share the rate limit.
	scheduled(controller, _env, ctx) {
		if (controller.cron === LINK_CHECK_CRON) {
			ctx.waitUntil(Promise.all([runLinkHealthCheck(), pruneJobEvents()]));
		} else if (controller.cron === DAILY_RECORD_CRON) {
			ctx.waitUntil(
				Promise.all([
					runDailyRecordPick(),
					...(isMonthlyRefreshDay(controller.scheduledTime)
						? [refreshAllValues()]
						: []),
				]),
			);
		} else {
			ctx.waitUntil(runWeeklyDigest());
		}
	},
	queue: (batch) => handleAnalyzeBatch(batch as MessageBatch<AnalyzeMessage>),
	// No `email()` export: the inbound half of the daily-record flow (a reply
	// landing back as that record's notes) runs through a Mailgun webhook route
	// instead of Cloudflare Email Routing — see
	// src/routes/api/inbound.daily-record.ts for why.
};

export default Sentry.withSentry(
	(env) =>
		// Only the production deployment reports. `import.meta.env.DEV` is true
		// under local `vite dev`; the `ENVIRONMENT` var (wrangler.jsonc) is
		// "preview" on the preview deploy. Returning undefined skips init entirely
		// — `Sentry.startSpan` stays a no-op that still runs its callback.
		import.meta.env.DEV || env.ENVIRONMENT !== "production"
			? undefined
			: {
					// Public DSN, build-time inlined — no runtime Wrangler var needed.
					dsn: import.meta.env.VITE_SENTRY_DSN,
					environment: env.ENVIRONMENT,
					sendDefaultPii: true,
					tracesSampleRate: 1.0,
				},
	handler,
);
