import { env } from "cloudflare:workers";
import { lt } from "drizzle-orm";

import { getDb } from "#/db";
import { type JobEvent, jobEvents } from "#/db/schema";

/** How long the Activity page keeps a job event. */
const KEEP_DAYS = 14;

/**
 * Record what a background job did, for the admin Activity page. Best-effort: a
 * failed write is logged and dropped, so it can never fail the job itself.
 */
export async function logJobEvent(
	kind: JobEvent["kind"],
	level: JobEvent["level"],
	recordId: number | null,
	message: string,
): Promise<void> {
	await getDb(env.DB)
		.insert(jobEvents)
		.values({ kind, level, recordId, message })
		.catch((err) => console.error("[job-events] write failed", err));
}

/** Delete job events older than {@link KEEP_DAYS}. Run by the daily cron. */
export async function pruneJobEvents(): Promise<void> {
	const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
	await getDb(env.DB).delete(jobEvents).where(lt(jobEvents.createdAt, cutoff));
}
