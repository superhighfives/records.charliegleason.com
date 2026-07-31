import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { colors } from "#/db/schema";
import {
	COLOR_TEXTURE_MODEL,
	COLOR_TEXTURE_SIZE,
	colorTexturePrompt,
} from "#/lib/color-texture-config";
import { blobStream } from "#/lib/professional";
import { firstOutputUrl, runVersion } from "#/lib/replicate";
import { NonRetryableError, withRetry } from "#/lib/retry";

/**
 * Generate (or regenerate) a color's reference vinyl texture — a flat material swatch
 * for the given color name — via Replicate, and cache it in R2. Runs in the
 * "color-texture" queue consumer (see `queue.ts`), triggered automatically when a
 * genuinely-new color is created (`createColor`) and manually via `regenerateColorTexture`.
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

		// Best-effort cleanup of the previous texture, if this is a regeneration.
		if (color.textureImageKey) {
			await env.PHOTOS.delete(color.textureImageKey).catch(() => {});
		}

		await db
			.update(colors)
			.set({ textureImageKey: key, textureStatus: "ready", textureError: null })
			.where(eq(colors.id, colorId));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		await db
			.update(colors)
			.set({ textureStatus: "failed", textureError: detail })
			.where(eq(colors.id, colorId))
			.catch(() => {});
		throw err;
	}
}
