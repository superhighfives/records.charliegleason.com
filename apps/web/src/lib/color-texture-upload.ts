import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { colors } from "#/db/schema";
import { paletteJsonFromTexture } from "#/lib/color-texture";
import { COLOR_TEXTURE_SIZE } from "#/lib/color-texture-config";
import { blobStream } from "#/lib/professional";

/**
 * Store a manually-uploaded image as a color's reference vinyl texture, in place
 * of the AI-generated one (see `color-texture.ts`) — same storage shape (a
 * `COLOR_TEXTURE_SIZE` square webp under `textures/`), just skipping Replicate.
 * Used by `uploadColorTexture` (the combobox's upload affordance).
 */
export async function storeColorTextureUpload(
	colorId: number,
	bytes: Uint8Array,
): Promise<void> {
	const db = getDb(env.DB);
	const [color] = await db
		.select()
		.from(colors)
		.where(eq(colors.id, colorId))
		.limit(1);
	if (!color) return; // deleted before the upload landed

	const out = await env.IMAGES.input(blobStream(bytes))
		.transform({
			width: COLOR_TEXTURE_SIZE,
			height: COLOR_TEXTURE_SIZE,
			fit: "cover",
		})
		.output({ format: "image/webp", quality: 90 });
	const webp = await out.response().arrayBuffer();

	const key = `textures/${crypto.randomUUID()}.webp`;
	await env.PHOTOS.put(key, webp, {
		httpMetadata: { contentType: "image/webp" },
	});

	// Sample the title-gradient palette from the same bytes we just stored.
	// A failed extraction returns null — don't clobber an existing palette.
	const palette = paletteJsonFromTexture(new Uint8Array(webp)) ?? color.palette;

	// Best-effort cleanup of the previous texture, being replaced by this upload.
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
}
