import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";

// The exact widths callers request (see `photoUrl` call sites) — snapping `?w=`
// to this set means every request lands on the same handful of cached variants
// instead of a public, unauthenticated caller being able to force up to 2048
// distinct (paid) Image Transformations per photo by varying the query param.
const ALLOWED_WIDTHS = [350, 500, 800, 1600];

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * Serve a vinyl cover/matte photo from R2 by key (e.g. /api/photos/covers/abc.jpg).
 * Public read — cover art isn't sensitive.
 *
 * An optional `?w=` resizes + re-encodes to webp on the way out via the Cloudflare
 * Images binding — the stored masters run up to ~1MB, but no display surface
 * needs more than a few hundred px, so callers ask for the size they actually
 * render at (see `photoUrl` in `#/lib/cover`) instead of shipping the master
 * every time.
 */
export const Route = createFileRoute("/api/photos/$")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const key = params._splat;
				if (!key) return new Response("Not found", { status: 404 });

				const object = await env.PHOTOS.get(key);
				if (!object) return new Response("Not found", { status: 404 });

				const contentType =
					object.httpMetadata?.contentType ?? "application/octet-stream";
				const width = clampWidth(new URL(request.url).searchParams.get("w"));
				if (width == null) {
					return new Response(object.body, {
						headers: {
							"content-type": contentType,
							"cache-control": IMMUTABLE_CACHE,
						},
					});
				}

				// Buffered (not streamed) into IMAGES so the bytes are still on hand for
				// the fallback below if the transform itself fails — a stream can only
				// be read once, and Image Transformations being disabled shouldn't turn
				// a resize request into a broken image.
				const bytes = await object.arrayBuffer();
				try {
					const out = await env.IMAGES.input(new Blob([bytes]).stream())
						.transform({ width, fit: "scale-down" })
						.output({ format: "image/webp", quality: 82 });
					return new Response(await out.response().arrayBuffer(), {
						headers: {
							"content-type": "image/webp",
							"cache-control": IMMUTABLE_CACHE,
						},
					});
				} catch (error) {
					console.error("Image transform failed, serving original", error);
					return new Response(bytes, {
						headers: {
							"content-type": contentType,
							"cache-control": IMMUTABLE_CACHE,
						},
					});
				}
			},
		},
	},
});

function clampWidth(raw: string | null): number | null {
	if (!raw) return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return null;
	return ALLOWED_WIDTHS.reduce((closest, width) =>
		Math.abs(width - n) < Math.abs(closest - n) ? width : closest,
	);
}
