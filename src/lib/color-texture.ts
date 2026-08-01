import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { colors } from "#/db/schema";
import { extractPalette } from "#/lib/color-palette";
import {
	COLOR_TEXTURE_MODEL,
	COLOR_TEXTURE_SIZE,
	colorTexturePrompt,
} from "#/lib/color-texture-config";
import { blobStream, decodeRgba } from "#/lib/professional";
import { firstOutputUrl, runVersion } from "#/lib/replicate";
import { NonRetryableError, withRetry } from "#/lib/retry";

/**
 * Sample a title-gradient palette from encoded texture bytes (see
 * `color-palette.ts`), returned as JSON for the `colors.palette` column.
 * Best-effort: a decode/extract failure returns null so it can never fail the
 * texture job it rides along with — the title just stays untinted until a later
 * regeneration or backfill fills it in.
 */
export function paletteJsonFromTexture(bytes: Uint8Array): string | null {
	try {
		const palette = extractPalette(decodeRgba(bytes));
		return palette ? JSON.stringify(palette) : null;
	} catch (err) {
		console.error("Color palette extraction failed", err);
		return null;
	}
}

/**
 * Backfill (or refresh) just the palette for a color that already has a stored
 * texture, WITHOUT re-running Replicate — decode the existing R2 object and
 * re-extract. Drives the `color-palette` queue job (see `queue.ts` /
 * `backfillColorPalettes`); a no-op for a color with no ready texture.
 */
export async function extractStoredColorPalette(
	colorId: number,
): Promise<void> {
	const db = getDb(env.DB);
	const [color] = await db
		.select()
		.from(colors)
		.where(eq(colors.id, colorId))
		.limit(1);
	if (!color?.textureImageKey) return;

	const object = await env.PHOTOS.get(color.textureImageKey);
	if (!object) return; // texture object vanished — leave the palette as-is
	const bytes = new Uint8Array(await object.arrayBuffer());
	const palette = paletteJsonFromTexture(bytes);
	if (!palette) return; // extraction failed; don't clobber an existing palette

	await db.update(colors).set({ palette }).where(eq(colors.id, colorId));
}

/**
 * Generate (or regenerate) a color's reference vinyl texture — a flat material swatch
 * for the given color name — via Replicate, and cache it in R2. Runs in the
 * "color-texture" queue consumer (see `queue.ts`), triggered automatically when a
 * genuinely-new color is created (`createColor`, `createRecord`, `captureRecord` —
 * all via `getOrCreateColor`) and manually via `regenerateColorTexture`.
 *
 * The swatch is deliberately not a full disc render: `VinylDisc` (the frontend
 * component) composites this texture with procedural grooves + a punched spindle
 * hole, so sizing/stacking/hover-animation stay cheap CSS/SVG work regardless of
 * what the swatch looks like.
 */
export async function generateColorTexture(colorId: number): Promise<void> {
	const db = getDb(env.DB);
	const [color] = await db
		.select()
		.from(colors)
		.where(eq(colors.id, colorId))
		.limit(1);
	if (!color) return; // deleted between enqueue and delivery

	await db
		.update(colors)
		.set({ textureStatus: "processing", textureError: null })
		.where(eq(colors.id, colorId));

	try {
		const prediction = await runVersion(COLOR_TEXTURE_MODEL, {
			prompt: colorTexturePrompt(color.name),
			aspect_ratio: "1:1",
			num_outputs: 1,
			output_format: "png",
		});
		const url = firstOutputUrl(prediction.output);
		if (!url) {
			throw new NonRetryableError(
				`Replicate returned no output for color texture "${color.name}"`,
			);
		}

		const webp = await withRetry(
			async () => {
				const res = await fetch(url);
				if (!res.ok) {
					throw new NonRetryableError(
						`Fetching the generated texture failed (${res.status})`,
					);
				}
				const bytes = new Uint8Array(await res.arrayBuffer());
				const out = await env.IMAGES.input(blobStream(bytes))
					.transform({
						width: COLOR_TEXTURE_SIZE,
						height: COLOR_TEXTURE_SIZE,
						fit: "cover",
					})
					.output({ format: "image/webp", quality: 90 });
				return out.response().arrayBuffer();
			},
			{ attempts: 3, baseMs: 400 },
		);

		const key = `textures/${crypto.randomUUID()}.webp`;
		await env.PHOTOS.put(key, webp, {
			httpMetadata: { contentType: "image/webp" },
		});

		// Sample the title-gradient palette from the same bytes we just stored.
		// A failed extraction returns null — don't clobber an existing palette.
		const palette =
			paletteJsonFromTexture(new Uint8Array(webp)) ?? color.palette;

		// Best-effort cleanup of the previous texture, if this is a regeneration.
		if (color.textureImageKey) {
			await env.PHOTOS.delete(color.textureImageKey).catch(() => {});
		}

		await db
			.update(colors)
			.set({
				textureImageKey: key,
				textureStatus: "ready",
				textureError: null,
				palette,
			})
			.where(eq(colors.id, colorId));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		// Best-effort status write; if this also fails there's nothing more we can
		// do here, but log it so a wedged "processing" color isn't invisible.
		await db
			.update(colors)
			.set({ textureStatus: "failed", textureError: detail })
			.where(eq(colors.id, colorId))
			.catch((writeErr) => {
				console.error("Failed to record color texture failure", writeErr);
			});
		throw err;
	}
}
