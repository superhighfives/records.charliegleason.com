import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "#/db";
import { type Color, colors } from "#/db/schema";
import { authMiddleware, getAdminSession } from "#/lib/auth";
import { enqueueColorTexture } from "#/lib/queue";

/** New records without an explicit color default to this chip — see `records.ts`. */
export const DEFAULT_COLOR_NAME = "Black";

/**
 * Get-or-create a color chip by name. Upserts on the unique `name` so calling
 * this with an existing name (even a stale option from before someone else
 * created it) attaches the same chip instead of racing a duplicate insert. A
 * genuinely new color kicks off its reference vinyl texture generation (see
 * `color-texture.ts`); re-attaching an existing one doesn't re-trigger it.
 * Shared by the `createColor` server fn (the combobox) and record creation
 * (`records.ts`, defaulting an unset color to {@link DEFAULT_COLOR_NAME}).
 *
 * Wrapped in `createServerOnlyFn` (mirrors `getAdminSession` in `auth.ts`):
 * unlike a `createServerFn` handler body, a plain exported function touching
 * `env` doesn't get its `cloudflare:workers` import stripped from the client
 * bundle — and this file is transitively reachable from client code (`colors.ts`
 * is imported by `records.ts`, which client routes import via `records-queries.ts`).
 */
export const getOrCreateColor = createServerOnlyFn(
	async (name: string): Promise<Color> => {
		const db = getDb(env.DB);
		const inserted = await db
			.insert(colors)
			.values({ name })
			.onConflictDoNothing({ target: colors.name })
			.returning();
		if (inserted.length) {
			await enqueueColorTexture(inserted[0].id).catch((err) => {
				Sentry.captureException(err);
			});
			return inserted[0];
		}
		const [row] = await db.select().from(colors).where(eq(colors.name, name));
		return row;
	},
);

/** All vinyl color chips, for the admin combobox's suggestion list. */
export const listColors = createServerFn({ method: "GET" }).handler(() =>
	Sentry.startSpan({ name: "listColors" }, async () => {
		if (!(await getAdminSession())) return [];
		const db = getDb(env.DB);
		return db.select().from(colors).orderBy(asc(colors.name));
	}),
);

const createColorSchema = z.object({
	name: z.string().trim().min(1, "Color name is required"),
});

/** The combobox's "create '<value>'" action — see {@link getOrCreateColor}. */
export const createColor = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => createColorSchema.parse(data))
	.handler(({ data: { name } }) =>
		Sentry.startSpan({ name: "createColor" }, () => getOrCreateColor(name)),
	);

/**
 * Re-queue a color's reference texture generation — the combobox's "regenerate"
 * affordance. Marks the color `queued` immediately so the UI reflects the retry
 * without waiting on the consumer to pick it up.
 */
export const regenerateColorTexture = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) =>
		z.object({ colorId: z.number().int() }).parse(data),
	)
	.handler(({ data: { colorId } }) =>
		Sentry.startSpan({ name: "regenerateColorTexture" }, async () => {
			const db = getDb(env.DB);
			await db
				.update(colors)
				.set({ textureStatus: "queued", textureError: null })
				.where(eq(colors.id, colorId));
			await enqueueColorTexture(colorId);
		}),
	);
