import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { count, desc, eq, gt } from "drizzle-orm";

import { getDb } from "#/db";
import { jobEvents, records } from "#/db/schema";
import { getAdminSession } from "#/lib/auth";
import { VALUE_QUEUE_WINDOW_MS } from "#/lib/record-alerts";

/** The newest job events shown on the Activity page. */
const EVENT_LIMIT = 200;

export type ActivityEvent = Awaited<ReturnType<typeof listJobEvents>>[number];

/**
 * The newest job events, each with its record's artist and title. `errorsOnly`
 * filters here rather than in the page, so a burst of routine events (a monthly
 * re-price writes hundreds) can't push errors out of the newest-N window. Returns
 * an empty list without a session, like `listInFlight`, because the header polls
 * it before Clerk has signed in.
 */
export const listJobEvents = createServerFn({ method: "GET" })
	.validator((errorsOnly: boolean) => errorsOnly)
	.handler(({ data: errorsOnly }) =>
		Sentry.startSpan({ name: "listJobEvents" }, async () => {
			if (!(await getAdminSession())) return [];
			return getDb(env.DB)
				.select({
					id: jobEvents.id,
					createdAt: jobEvents.createdAt,
					kind: jobEvents.kind,
					level: jobEvents.level,
					recordId: jobEvents.recordId,
					message: jobEvents.message,
					artist: records.artist,
					title: records.title,
				})
				.from(jobEvents)
				.leftJoin(records, eq(records.id, jobEvents.recordId))
				.where(errorsOnly ? eq(jobEvents.level, "error") : undefined)
				.orderBy(desc(jobEvents.id))
				.limit(EVENT_LIMIT);
		}),
	);

/** How many value fetches are queued and not yet finished. */
export const countQueuedValues = createServerFn({ method: "GET" }).handler(() =>
	Sentry.startSpan({ name: "countQueuedValues" }, async () => {
		if (!(await getAdminSession())) return 0;
		const since = new Date(Date.now() - VALUE_QUEUE_WINDOW_MS);
		const [row] = await getDb(env.DB)
			.select({ n: count() })
			.from(records)
			.where(gt(records.discogsValueQueuedAt, since));
		return row?.n ?? 0;
	}),
);
