import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The 3D wall prototype now lives in the real collection page (header,
 * filters, footer and record panel included) behind the `?wall` flag — see
 * `useWallMode` in collection-view.tsx. Kept as a short link.
 */
export const Route = createFileRoute("/wall")({
	beforeLoad: () => {
		throw redirect({ href: "/?wall" });
	},
});
