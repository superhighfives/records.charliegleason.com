import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { asc, eq, isNotNull } from "drizzle-orm";

import { getDb } from "#/db";
import { records } from "#/db/schema";
import {
	checkMasterLiveness,
	checkReleaseLiveness,
	type Liveness,
} from "#/lib/discogs";

/**
 * How many links to validate per resource type per run. Discogs allows 60
 * requests/min authenticated, and a scheduled invocation has a bounded wall-clock
 * budget, so each pass is capped and successive runs cover the rest. Rows are
 * validated stalest-first (see the ORDER BY), so the whole collection is swept
 * within a few days and then continuously re-validated — a link that dies later is
 * caught on the next pass over it.
 */
const CHECK_BATCH = 50;

/** Spacing between Discogs calls to stay under the 60/min authenticated limit. */
const THROTTLE_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LinkTally = {
	checked: number;
	gone: number;
	live: number;
	inconclusive: number;
};

export type LinkHealthResult = { masters: LinkTally; releases: LinkTally };

/**
 * Validate a batch of one link kind and apply the result. `check` maps an id to
 * its liveness; `apply` persists the resolved missing/live flag for a row. An
 * inconclusive result touches neither the flag nor `checkedAt`, so the row stays
 * near the front of the stalest-first queue and is retried before confirmed ones.
 */
async function sweep(
	rows: Array<{ id: number; linkId: string | null }>,
	check: (id: string) => Promise<Liveness>,
	apply: (id: number, missing: boolean) => Promise<unknown>,
): Promise<LinkTally> {
	const tally: LinkTally = { checked: 0, gone: 0, live: 0, inconclusive: 0 };
	for (const [i, row] of rows.entries()) {
		if (!row.linkId) continue;
		const liveness = await check(row.linkId);
		tally.checked++;
		if (liveness === "inconclusive") {
			tally.inconclusive++;
		} else {
			const missing = liveness === "gone";
			if (missing) tally.gone++;
			else tally.live++;
			await apply(row.id, missing);
		}
		// Space out calls to stay under the rate limit (skip the trailing wait).
		if (i < rows.length - 1) await sleep(THROTTLE_MS);
	}
	return tally;
}

/**
 * Scheduled Discogs link-health check. Validates records' linked masters *and*
 * releases against the Discogs API — a record can be identified by either (a
 * release can stand alone since #117), and both can be deleted/merged on Discogs
 * and start 404ing. Each resource type is swept independently, stalest-first, up to
 * {@link CHECK_BATCH} rows:
 *
 *   - 404 (deleted/merged) → set the `*Missing` flag   (feeds the admin banner)
 *   - 200 (resolves)       → clear it                   (self-heals a re-link/restore)
 *   - transient/auth error → leave the row untouched    (retries next run, no false flag)
 *
 * Driven by the cron trigger (src/server.ts) or the protected
 * /api/cron/master-check route. Returns a per-run tally per resource type.
 */
export async function runLinkHealthCheck(): Promise<LinkHealthResult> {
	return Sentry.startSpan({ name: "runLinkHealthCheck" }, async () => {
		const db = getDb(env.DB);

		// Stalest-first: SQLite sorts NULLs before non-NULLs under ASC, so
		// never-checked rows lead, then the least-recently validated.
		const dueMasters = await db
			.select({ id: records.id, linkId: records.masterId })
			.from(records)
			.where(isNotNull(records.masterId))
			.orderBy(asc(records.masterCheckedAt))
			.limit(CHECK_BATCH);
		const masters = await sweep(
			dueMasters,
			checkMasterLiveness,
			(id, missing) =>
				db
					.update(records)
					.set({ masterMissing: missing, masterCheckedAt: new Date() })
					.where(eq(records.id, id)),
		);

		const dueReleases = await db
			.select({ id: records.id, linkId: records.discogsId })
			.from(records)
			.where(isNotNull(records.discogsId))
			.orderBy(asc(records.releaseCheckedAt))
			.limit(CHECK_BATCH);
		// Pause between passes so the boundary doesn't fire two calls back-to-back
		// against the rate limit.
		if (masters.checked && dueReleases.length) await sleep(THROTTLE_MS);
		const releases = await sweep(
			dueReleases,
			checkReleaseLiveness,
			(id, missing) =>
				db
					.update(records)
					.set({ releaseMissing: missing, releaseCheckedAt: new Date() })
					.where(eq(records.id, id)),
		);

		return { masters, releases };
	});
}
