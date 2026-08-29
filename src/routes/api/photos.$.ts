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
 * An optional `?w=` resizes + re-encodes on the way out via the Cloudflare Images
 * binding — the stored masters run up to ~1MB, but no display surface needs more
 * than a few hundred px, so callers ask for the size they actually render at (see
 * `photoUrl` in `#/lib/cover`) instead of shipping the master every time. `?format=`
 * only takes effect alongside `?w=` (it selects the re-encode's output codec, so it's
 * meaningless without a transform); omitted or unrecognized falls back to webp, the
 * existing default every current caller relies on.
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
				const searchParams = new URL(request.url).searchParams;
				const width = clampWidth(searchParams.get("w"));
				if (width == null) {
					return new Response(object.body, {
						headers: {
							"content-type": contentType,
							"cache-control": IMMUTABLE_CACHE,
						},
					});
				}
				// webp (via the IMAGES binding, below) beats jpeg on size for every
				// browser caller — jpeg exists only for embedded callers with no webp
				// decoder (the ESP32 record-slideshow board). The `IMAGES` binding's
				// `output({format})` only offers "image/jpeg", which Cloudflare encodes
				// as progressive — but the board's decoder (esp_jpeg, wrapping TJpgDec)
				// is baseline-only, so a progressive JPEG decodes as garbage or fails
				// outright. "baseline-jpeg" exists only on the older `cf.image`
				// fetch-based transform, not the binding, so a jpeg request re-fetches
				// this same route's un-transformed passthrough (no `w`/`format`, so it
				// can't recurse) through that transform instead of going through `IMAGES`.
				if (searchParams.get("format") === "jpeg") {
					const passthroughUrl = new URL(request.url);
					passthroughUrl.search = "";
					const transformed = await fetch(passthroughUrl, {
						cf: {
							image: {
								width,
								fit: "scale-down",
								format: "baseline-jpeg",
								quality: 82,
							},
						},
					});
					if (!transformed.ok) {
						console.error(
							"Baseline JPEG transform failed, cannot honor format",
							transformed.status,
						);
						return new Response("Image transform failed", { status: 502 });
					}
					return new Response(transformed.body, {
						headers: {
							"content-type": "image/jpeg",
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
