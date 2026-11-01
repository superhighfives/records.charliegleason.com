import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { settings } from "#/db/schema";
import { authMiddleware } from "#/lib/auth";
import {
	DEFAULT_FILTER_SETTINGS,
	FILTER_SETTINGS_KEY,
	filterSettingsSchema,
	normalizeFilterSettings,
} from "#/lib/filter-settings";
import { isTransientD1Error, withRetry } from "#/lib/retry";

/**
 * The public filter strip's config. Public (the collection page reads it)
 * and never throws: a missing row, bad JSON, or a missing `settings` table
 * (a preview deploy, where migrations don't run) all mean the defaults.
 */
export const getFilterSettings = createServerFn({ method: "GET" }).handler(() =>
	Sentry.startSpan({ name: "getFilterSettings" }, async () => {
		try {
			const db = getDb(env.DB);
			// D1 sometimes fails a read with a transient internal error
			// (RECORDS-2A); one more try a moment later gets past it.
			const [row] = await withRetry(
				() =>
					db
						.select({ value: settings.value })
						.from(settings)
						.where(eq(settings.key, FILTER_SETTINGS_KEY))
						.limit(1),
				{ attempts: 2, baseMs: 150, shouldRetry: isTransientD1Error },
			);
			return normalizeFilterSettings(row ? JSON.parse(row.value) : null);
		} catch (err) {
			Sentry.captureException(err);
			return DEFAULT_FILTER_SETTINGS;
		}
	}),
);

/** Save the filter strip's config from `/admin/filters`. */
export const saveFilterSettings = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => filterSettingsSchema.parse(data))
	.handler(({ data }) =>
		Sentry.startSpan({ name: "saveFilterSettings" }, async () => {
			const value = JSON.stringify(normalizeFilterSettings(data));
			const db = getDb(env.DB);
			await db
				.insert(settings)
				.values({ key: FILTER_SETTINGS_KEY, value, updatedAt: new Date() })
				.onConflictDoUpdate({
					target: settings.key,
					set: { value, updatedAt: new Date() },
				});
		}),
	);
