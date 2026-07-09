import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "#/components/not-found";

export const Route = createFileRoute("/404")({
	// A real matched route, so it responds 200 — keep it out of the index so the
	// preview page isn't crawled as genuine content.
	head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
	component: NotFound,
});
