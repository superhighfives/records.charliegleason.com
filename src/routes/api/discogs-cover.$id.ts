import { createFileRoute } from "@tanstack/react-router";

import { discogsCoverResponse } from "#/lib/discogs-cover";

/**
 * Proxy the full-res primary cover for a Discogs release id.
 *
 * Used by the admin review page to preview (and verify the download of) a
 * candidate's artwork before publishing — the real cover isn't sourced into R2
 * until publish. Going through our own origin means the browser gets a reliable,
 * inspectable image (Discogs' API needs a token + User-Agent, and streaming the
 * bytes here sidesteps any cross-origin/hotlink surprises in an <img>).
 *
 * Public read: cover art isn't sensitive. Every hit spends one Discogs API call
 * (rate-limited 60/min), so this is deliberately admin-triggered, not a hot path.
 */
export const Route = createFileRoute("/api/discogs-cover/$id")({
	server: {
		handlers: {
			GET: ({ params }) => discogsCoverResponse(params.id),
		},
	},
});
