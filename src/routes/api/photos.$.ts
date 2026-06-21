import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";

/**
 * Serve a vinyl cover photo from R2 by key (e.g. /api/photos/covers/abc.jpg).
 * Public read — cover art isn't sensitive.
 */
export const Route = createFileRoute("/api/photos/$")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const key = params._splat;
				if (!key) return new Response("Not found", { status: 404 });

				const object = await env.PHOTOS.get(key);
				if (!object) return new Response("Not found", { status: 404 });

				return new Response(object.body, {
					headers: {
						"content-type":
							object.httpMetadata?.contentType ?? "application/octet-stream",
						"cache-control": "public, max-age=31536000, immutable",
					},
				});
			},
		},
	},
});
