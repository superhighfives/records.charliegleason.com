import { createFileRoute, redirect } from "@tanstack/react-router";

/** The table replaced the grid: old `/grid` links land on it. */
export const Route = createFileRoute("/grid/")({
	beforeLoad: () => {
		throw redirect({ to: "/table", statusCode: 301 });
	},
});
