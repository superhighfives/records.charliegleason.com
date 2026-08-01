import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { asc, count, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "#/db";
import { type Color, colors, records } from "#/db/schema";
import { authMiddleware, getAdminSession } from "#/lib/auth";
import { storeColorTextureUpload } from "#/lib/color-texture-upload";
import { base64ToBytes, stripDataUrl } from "#/lib/image-data";
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

/**
 * All vinyl color chips, for the admin combobox's suggestion list — each with
 * `recordCount`, the number of records currently using it, so the "delete"
 * confirm dialog can warn how many will be reset to {@link DEFAULT_COLOR_NAME}.
 */
export const listColors = createServerFn({ method: "GET" }).handler(() =>
	Sentry.startSpan({ name: "listColors" }, async () => {
		if (!(await getAdminSession())) return [];
		const db = getDb(env.DB);
		const [rows, usage] = await Promise.all([
			db.select().from(colors).orderBy(asc(colors.name)),
			db
				.select({ colorId: records.colorId, count: count() })
				.from(records)
				.where(isNotNull(records.colorId))
				.groupBy(records.colorId),
		]);
		const usageById = new Map(usage.map((u) => [u.colorId, u.count]));
		return rows.map((r) => ({
			...r,
			recordCount: usageById.get(r.id) ?? 0,
		}));
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

/**
 * Upload a color's reference vinyl texture directly, in place of the
 * AI-generated one — the combobox's upload affordance. Same storage shape as a
 * generated texture (see `color-texture-upload.ts`), so `VinylDisc` can't tell
 * the difference; this just skips the Replicate round-trip entirely.
 */
export const uploadColorTexture = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) => {
		const d = (data ?? {}) as Record<string, unknown>;
		if (typeof d.colorId !== "number") {
			throw new Error("colorId must be a number");
		}
		if (typeof d.imageBase64 !== "string" || d.imageBase64.length === 0) {
			throw new Error("imageBase64 must be a non-empty string");
		}
		return { colorId: d.colorId, imageBase64: d.imageBase64 };
	})
	.handler(({ data: { colorId, imageBase64 } }) =>
		Sentry.startSpan({ name: "uploadColorTexture" }, () =>
			storeColorTextureUpload(
				colorId,
				base64ToBytes(stripDataUrl(imageBase64)),
			),
		),
	);

/**
 * Delete a color chip. Every record using it is reassigned to
 * {@link DEFAULT_COLOR_NAME} first (rather than left dangling on a colorId that
 * no longer exists) — the combobox confirms this with the user, showing
 * `recordCount` from `listColors`, before calling this. Refuses to delete
 * `DEFAULT_COLOR_NAME` itself: it's the fallback every reassignment (including
 * this one, for any OTHER color) targets, so deleting it would leave nothing to
 * reassign to.
 */
export const deleteColor = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) =>
		z.object({ colorId: z.number().int() }).parse(data),
	)
	.handler(({ data: { colorId } }) =>
		Sentry.startSpan({ name: "deleteColor" }, async () => {
			const db = getDb(env.DB);
			const [color] = await db
				.select()
				.from(colors)
				.where(eq(colors.id, colorId))
				.limit(1);
			if (!color) return; // already gone

			if (color.name === DEFAULT_COLOR_NAME) {
				throw new Error(
					`"${DEFAULT_COLOR_NAME}" can't be deleted — it's the default every other color's records reset to.`,
				);
			}

			const black = await getOrCreateColor(DEFAULT_COLOR_NAME);
			await db
				.update(records)
				.set({ colorId: black.id })
				.where(eq(records.colorId, colorId));

			if (color.textureImageKey) {
				await env.PHOTOS.delete(color.textureImageKey).catch(() => {});
			}
			await db.delete(colors).where(eq(colors.id, colorId));

			// So a caller currently pointed at the deleted color (e.g. the record
			// form it was just picked from) can update its own selection in place.
			return { blackId: black.id };
		}),
	);
