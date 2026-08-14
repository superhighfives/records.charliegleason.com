import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import {
	getResponseHeaders,
	getResponseStatus,
} from "@tanstack/react-start/server";
import { getAdminSession } from "#/lib/auth";
import { storeCapturePhotoFromR2 } from "#/lib/images";
import { createCaptureRecord } from "#/lib/records";

/**
 * Capture upload: the photo arrives as the raw request body (context/colorId as
 * query params) and is streamed straight into R2, then canonicalised from there.
 * This is deliberately not a `createServerFn` POST — a base64-in-JSON payload
 * holds ~6 copies of the photo in the isolate at once (body string, parsed
 * payload, atob string, bytes, Blob, transform output), which blew the 128 MB
 * memory limit whenever the client fell back to uploading an unshrunk original.
 * Admin-only, gated the same way as `/api/admin/backup`.
 */
export const Route = createFileRoute("/api/admin/capture")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				if (!(await getAdminSession())) {
					// Carry a staged auth-handshake redirect across, same as backup.ts —
					// this handler returns its own `Response`, so the 307 + Set-Cookie
					// `getAdminSession` staged would otherwise be silently dropped.
					if (getResponseStatus() === 307) {
						return new Response(null, {
							status: 307,
							headers: getResponseHeaders() as HeadersInit,
						});
					}
					return new Response("Unauthorized", { status: 401 });
				}

				if (!request.body) {
					return new Response("Missing image body", { status: 400 });
				}
				const contentType = request.headers.get("content-type");
				const mediaType = contentType?.startsWith("image/")
					? contentType
					: "image/jpeg";

				// Stream the body into R2 untouched — the isolate never buffers the
				// photo. If Image Transformations are down this raw object is the
				// capture itself, so name and type it accordingly.
				const ext = mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
				const rawKey = `captures/${crypto.randomUUID()}.${ext}`;
				await env.PHOTOS.put(rawKey, request.body, {
					httpMetadata: { contentType: mediaType },
				});
				const { key: capturePhotoKey } = await storeCapturePhotoFromR2(
					rawKey,
					mediaType,
				);

				const url = new URL(request.url);
				const context = url.searchParams.get("context") ?? undefined;
				const colorIdRaw = url.searchParams.get("colorId");
				const colorId =
					colorIdRaw && colorIdRaw.trim() !== ""
						? Number(colorIdRaw)
						: undefined;

				const row = await createCaptureRecord({
					capturePhotoKey,
					context,
					colorId:
						colorId != null && Number.isFinite(colorId) ? colorId : undefined,
				});
				return Response.json(row);
			},
		},
	},
});
