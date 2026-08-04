import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/tanstackstart-react";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { and, asc, count, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "#/db";
import { type Color, colors, records } from "#/db/schema";
import { authMiddleware, getAdminSession } from "#/lib/auth";
import { storeColorTextureUpload } from "#/lib/color-texture-upload";
import { base64ToBytes, stripDataUrl } from "#/lib/image-data";
import { enqueueColorPalette, enqueueColorTexture } from "#/lib/queue";

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
		// Re-attaching an existing color that never got a texture (idle) or whose
		// generation failed: kick it off now so picking such a chip is enough to
		// get its vinyl texture + title palette, without needing the manual
		// "regenerate" button. `queued`/`processing`/`ready` are left alone.
		if (
			row &&
			(row.textureStatus === "idle" || row.textureStatus === "failed")
		) {
			await queueColorTexture(row.id).catch((err) => {
				Sentry.captureException(err);
			});
			return { ...row, textureStatus: "queued", textureError: null };
		}
		return row;
	},
);

/**
 * Mark a color `queued` and enqueue its texture generation. The single write +
 * enqueue shared by every "(re)generate this color's texture" path — the
 * regenerate button, the on-select {@link ensureColorTexture}, and
 * {@link getOrCreateColor}'s re-attach branch. Sets `queued` up front so the UI
 * shows the retry immediately, before the consumer picks the job up.
 */
const queueColorTexture = createServerOnlyFn(async (colorId: number) => {
	const db = getDb(env.DB);
	await db
		.update(colors)
		.set({ textureStatus: "queued", textureError: null })
		.where(eq(colors.id, colorId));
	await enqueueColorTexture(colorId);
});

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
		Sentry.startSpan({ name: "regenerateColorTexture" }, () =>
			queueColorTexture(colorId),
		),
	);

/**
 * "Make sure this color has a texture" — the combobox fires this when a chip is
 * picked, so selecting a color whose texture never ran (`idle`) or failed is
 * enough to queue it. A no-op when the texture is already `queued`/`processing`/
 * `ready`, so re-picking a good chip costs nothing.
 */
export const ensureColorTexture = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) =>
		z.object({ colorId: z.number().int() }).parse(data),
	)
	.handler(({ data: { colorId } }) =>
		Sentry.startSpan({ name: "ensureColorTexture" }, async () => {
			const db = getDb(env.DB);
			const [row] = await db
				.select({ textureStatus: colors.textureStatus })
				.from(colors)
				.where(eq(colors.id, colorId))
				.limit(1);
			if (row?.textureStatus === "idle" || row?.textureStatus === "failed") {
				await queueColorTexture(colorId);
			}
		}),
	);

/**
 * Toggle whether a color is translucent vinyl — the combobox's transparency
 * affordance. Purely a render hint (`VinylDisc` drops the disc's fill opacity so
 * the page shows through); doesn't touch the generated texture.
 */
export const setColorTranslucent = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.validator((data: unknown) =>
		z
			.object({ colorId: z.number().int(), translucent: z.boolean() })
			.parse(data),
	)
	.handler(({ data: { colorId, translucent } }) =>
		Sentry.startSpan({ name: "setColorTranslucent" }, async () => {
			const db = getDb(env.DB);
			await db
				.update(colors)
				.set({ translucent })
				.where(eq(colors.id, colorId));
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
 * One-off backfill: enqueue a palette re-extraction (from the existing texture, no
 * Replicate call — see `extractStoredColorPalette`) for every `ready` color that's
 * still missing a `palette`. Idempotent and safe to re-run; returns how many jobs
 * it queued so the caller knows the backlog size. Newly-created/regenerated colors
 * get their palette inline, so this only exists to catch up pre-column rows.
 */
export const backfillColorPalettes = createServerFn({ method: "POST" })
	.middleware([authMiddleware])
	.handler(() =>
		Sentry.startSpan({ name: "backfillColorPalettes" }, async () => {
			const db = getDb(env.DB);
			const pending = await db
				.select({ id: colors.id })
				.from(colors)
				.where(and(eq(colors.textureStatus, "ready"), isNull(colors.palette)));
			for (const { id } of pending) {
				await enqueueColorPalette(id).catch((err) => {
					Sentry.captureException(err);
				});
			}
			return { queued: pending.length };
		}),
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

			// Best-effort cleanup of the texture; the color row is deleted
			// regardless, so worst case is an orphaned R2 object.
			if (color.textureImageKey) {
				await env.PHOTOS.delete(color.textureImageKey).catch(() => {});
			}
			await db.delete(colors).where(eq(colors.id, colorId));

			// So a caller currently pointed at the deleted color (e.g. the record
			// form it was just picked from) can update its own selection in place.
			return { blackId: black.id };
		}),
	);
