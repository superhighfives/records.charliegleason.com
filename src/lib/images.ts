import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";

import { getReleaseImageUrl } from "#/lib/discogs";

/**
 * Source a good-quality cover and store a resized copy in R2.
 *
 * The iPhone capture is kept as a reference (admin only); the *displayed* cover
 * comes from Discogs, resized to a sane size with the Cloudflare Images binding
 * (webp, max 600px). Returns the R2 key, or null on any failure (the record just
 * shows no cover then). Requires Image Transformations enabled on the account.
 */

const UA = "RecordsCharlieGleasonCom/1.0 +https://records.charliegleason.com";

export async function storeResizedCover(
	imageUrl: string,
): Promise<string | null> {
	try {
		const res = await fetch(imageUrl, { headers: { "User-Agent": UA } });
		if (!res.ok || !res.body) {
			console.error(
				`storeResizedCover: fetch failed (${res.status}) for ${imageUrl}`,
			);
			return null;
		}

		const out = await env.IMAGES.input(res.body)
			.transform({ width: 600, height: 600, fit: "scale-down" })
			.output({ format: "image/webp", quality: 82 });
		const bytes = await out.response().arrayBuffer();

		const key = `covers/${crypto.randomUUID()}.webp`;
		await env.PHOTOS.put(key, bytes, {
			httpMetadata: { contentType: "image/webp" },
		});
		return key;
	} catch (err) {
		// The image fetch (network/DNS), the transform (Image Transformations
		// disabled?), or the R2 put threw. Log it so a stale/missing cover is
		// diagnosable rather than silent.
		console.error("storeResizedCover: fetch/transform/store failed", err);
		Sentry.captureException(err);
		return null;
	}
}

/**
 * Store a user-uploaded cover. The browser already center-crops to a square and
 * downscales for a fast upload; Cloudflare Images canonicalises it to a webp of
 * the same size/format as the Discogs-sourced covers so they display uniformly.
 * Returns the R2 key, or null on failure (the caller keeps the existing cover).
 */
export async function storeUploadedCover(
	bytes: Uint8Array,
): Promise<string | null> {
	try {
		const out = await env.IMAGES.input(new Blob([bytes as BlobPart]).stream())
			.transform({ width: 600, height: 600, fit: "scale-down" })
			.output({ format: "image/webp", quality: 82 });
		const buffer = await out.response().arrayBuffer();
		const key = `covers/${crypto.randomUUID()}.webp`;
		await env.PHOTOS.put(key, buffer, {
			httpMetadata: { contentType: "image/webp" },
		});
		return key;
	} catch {
		return null;
	}
}

export async function sourceCoverFromDiscogs(
	discogsId: string,
): Promise<string | null> {
	const url = await getReleaseImageUrl(discogsId).catch((err) => {
		console.error(
			`sourceCoverFromDiscogs: getReleaseImageUrl threw for ${discogsId}`,
			err,
		);
		Sentry.captureException(err);
		return null;
	});
	if (!url) {
		console.error(
			`sourceCoverFromDiscogs: no cover image URL for release ${discogsId}`,
		);
		return null;
	}
	return storeResizedCover(url);
}

/**
 * Normalise an uploaded capture and store it in R2. The browser already crops to
 * a square and shrinks for a fast upload; Cloudflare Images then canonicalises it
 * to a square webp (consistent format/size, EXIF stripped) and guarantees the
 * square even if the client fell back to uploading the original.
 *
 * The capture is what the vision step reads, so this must always store *something*
 * — if Image Transformations are unavailable it falls back to the raw bytes.
 * Returns the R2 key plus the stored content type (used as the vision media type).
 */
/**
 * Canonicalise a capture that's already sitting in R2 (streamed there straight
 * from the upload request, so the isolate never buffers the original photo —
 * an unshrunk iPhone original held as ~6 base64/binary copies is what used to
 * blow the 128 MB memory limit). Reads the raw object as a stream, writes the
 * canonical square webp, and deletes the raw object. If the transform is
 * unavailable the raw object *is* the capture — same fallback as
 * `storeCapturePhoto`.
 */
export async function storeCapturePhotoFromR2(
	rawKey: string,
	fallbackMediaType: string,
): Promise<{ key: string; contentType: string }> {
	try {
		const raw = await env.PHOTOS.get(rawKey);
		if (!raw) throw new Error(`raw capture missing from R2: ${rawKey}`);
		const out = await env.IMAGES.input(raw.body)
			.transform({ width: 2048, height: 2048, fit: "cover" })
			.output({ format: "image/webp", quality: 90 });
		// The transformed webp is ~1 MB, so buffering it (unlike the original) is fine.
		const buffer = await out.response().arrayBuffer();
		const key = `captures/${crypto.randomUUID()}.webp`;
		await env.PHOTOS.put(key, buffer, {
			httpMetadata: { contentType: "image/webp" },
		});
		await env.PHOTOS.delete(rawKey).catch(() => {});
		return { key, contentType: "image/webp" };
	} catch {
		return { key: rawKey, contentType: fallbackMediaType };
	}
}

export async function storeCapturePhoto(
	bytes: Uint8Array,
	fallbackMediaType: string,
): Promise<{ key: string; contentType: string }> {
	try {
		const out = await env.IMAGES.input(new Blob([bytes as BlobPart]).stream())
			.transform({ width: 2048, height: 2048, fit: "cover" })
			.output({ format: "image/webp", quality: 90 });
		const buffer = await out.response().arrayBuffer();
		const key = `captures/${crypto.randomUUID()}.webp`;
		await env.PHOTOS.put(key, buffer, {
			httpMetadata: { contentType: "image/webp" },
		});
		return { key, contentType: "image/webp" };
	} catch {
		const ext =
			fallbackMediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
		const key = `captures/${crypto.randomUUID()}.${ext}`;
		await env.PHOTOS.put(key, bytes, {
			httpMetadata: { contentType: fallbackMediaType },
		});
		return { key, contentType: fallbackMediaType };
	}
}
