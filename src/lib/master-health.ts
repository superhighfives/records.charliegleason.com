import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { asc, eq, isNotNull } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import { checkMasterLiveness } from "#/lib/discogs";

/**
 * How many masters to validate per run. Discogs allows 60 requests/min
 * authenticated, and a scheduled invocation has a bounded wall-clock budget, so we
 * cap each run and let successive runs cover the rest. Rows are validated
 * stalest-first (see the ORDER BY), so with a daily cron the whole collection is
 * swept within a few days and then continuously re-validated — a master that dies
 * later gets caught on the next pass over it.
 */
const CHECK_BATCH = 50;

/** Spacing between Discogs calls to stay under the 60/min authenticated limit. */
const THROTTLE_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type MasterCheckResult = {
	checked: number;
	gone: number;
	live: number;
	inconclusive: number;
};

/**
 * Scheduled master-link health check. Walks records that have a linked Discogs
 * master, stalest-first, and validates each against the Discogs API:
 *
 *   - 404 (deleted/merged) → set `masterMissing = true`  (surfaced as the admin banner)
 *   - 200 (resolves)       → clear `masterMissing`       (self-heals a re-linked or restored master)
 *   - transient/auth error → leave the row untouched     (so it retries next run, no false flag)
 *
 * Only the first two update `masterCheckedAt`, so an inconclusive row stays at the
 * front of the stalest-first queue and is retried before rows we've confirmed.
 *
 * Driven by the cron trigger (src/server.ts) or the protected
 * /api/cron/master-check route. Returns a per-run tally for logging/manual runs.
 */
export async function runMasterCheck(): Promise<MasterCheckResult> {
	return Sentry.startSpan({ name: "runMasterCheck" }, async () => {
		const db = getDb(env.DB);

		// Stalest-first: SQLite sorts NULLs before non-NULLs under ASC, so
		// never-checked rows lead, then the least-recently validated.
		const due = await db
			.select({ id: records.id, masterId: records.masterId })
			.from(records)
			.where(isNotNull(records.masterId))
			.orderBy(asc(records.masterCheckedAt))
			.limit(CHECK_BATCH);

		const result: MasterCheckResult = {
			checked: 0,
			gone: 0,
			live: 0,
			inconclusive: 0,
		};

		for (const [i, row] of due.entries()) {
			if (!row.masterId) continue;
			const liveness = await checkMasterLiveness(row.masterId);
			result.checked++;

			if (liveness === "inconclusive") {
				// Don't touch masterMissing OR masterCheckedAt — a token/proxy/5xx blip
				// isn't evidence the master is gone, and leaving checkedAt stale keeps
				// this row at the front of the queue to retry.
				result.inconclusive++;
			} else {
				const missing = liveness === "gone";
				if (missing) result.gone++;
				else result.live++;
				await db
					.update(records)
					.set({ masterMissing: missing, masterCheckedAt: new Date() })
					.where(eq(records.id, row.id));
			}

			// Space out calls to stay under the rate limit (skip the trailing wait).
			if (i < due.length - 1) await sleep(THROTTLE_MS);
		}

		return result;
	});
}
