import * as Sentry from "@sentry/cloudflare";
import entry from "@tanstack/react-start/server-entry";

import { runWeeklyDigest } from "#/lib/digest";

// Re-export the container Durable Object so wrangler can bind it (see wrangler.jsonc
// `containers` + `durable_objects`). It fronts the matte render image in `containers/matte/`.
export { MatteContainer } from "#/lib/matte-container";

import { type AnalyzeMessage, handleAnalyzeBatch } from "#/lib/queue";

/**
 * Worker entry. Wraps TanStack Start's default fetch handler, adds a `scheduled`
 * (cron) handler for the weekly digest and a `queue` consumer for background
 * record analysis, and instruments the whole thing with Sentry on the Workers
 * runtime via `withSentry` (covers fetch, scheduled and queue, and powers the
 * `Sentry.startSpan` calls in server functions). Needs `nodejs_compat`
 * (AsyncLocalStorage) — set in wrangler.jsonc.
 */
const handler: ExportedHandler<Cloudflare.Env> = {
	// TanStack's handler takes (request); env/ctx are reached via cloudflare:workers.
	fetch: (request) => entry.fetch(request),
	scheduled(_controller, _env, ctx) {
		ctx.waitUntil(runWeeklyDigest());
	},
	queue: (batch) => handleAnalyzeBatch(batch as MessageBatch<AnalyzeMessage>),
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
