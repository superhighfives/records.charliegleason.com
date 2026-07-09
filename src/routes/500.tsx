import { createFileRoute } from "@tanstack/react-router";
import { ServerError } from "#/components/server-error";

export const Route = createFileRoute("/500")({
	// A real matched route, so it responds 200 — keep it out of the index so the
	// preview page isn't crawled as genuine content.
	head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
	component: ServerError,
});
