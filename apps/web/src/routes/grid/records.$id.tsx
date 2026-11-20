import { createFileRoute, redirect } from "@tanstack/react-router";

/** The table replaced the grid: old record links open on it instead. */
export const Route = createFileRoute("/grid/records/$id")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/table/records/$id",
			params: { id: params.id },
			statusCode: 301,
		});
	},
});
