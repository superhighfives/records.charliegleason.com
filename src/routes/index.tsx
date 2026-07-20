import { createFileRoute, redirect } from "@tanstack/react-router";

import { CollectionView } from "#/components/collection-view";
import { recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/")({
	// Back-compat: records used to deep-link as `/?record=<id>`; they now live at
	// `/records/<id>-<slug>`. Keep validating the old param so shared/bookmarked
	// links resolve, then redirect them to the canonical path.
	validateSearch: (
		search: globalThis.Record<string, unknown>,
	): { record?: number } => {
		const raw = search.record;
		const n =
			typeof raw === "number"
				? raw
				: typeof raw === "string"
					? Number(raw)
					: Number.NaN;
		return Number.isInteger(n) && n > 0 ? { record: n } : {};
	},
	beforeLoad: async ({ search, context }) => {
		if (search.record != null) {
			const data = await context.queryClient.ensureQueryData(
				publicRecordsQueryOptions,
			);
			const record = data.find((r) => r.id === search.record);
			throw record
				? redirect({ to: "/records/$id", params: { id: recordIdParam(record) } })
				: redirect({ to: "/" }); // unknown id → drop the stale param
		}
	},
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
	component: Home,
});

function Home() {
	return <CollectionView selectedId={null} />;
}
