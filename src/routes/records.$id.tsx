import { createFileRoute, redirect } from "@tanstack/react-router";

import { CollectionView } from "#/components/collection-view";
import { parseRecordIdParam, recordIdParam } from "#/lib/records-path";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

/**
 * A public record's page: `/records/<id>-<title-slug>`. The id is authoritative;
 * the slug is decorative, so the loader canonicalises a missing/stale slug and
 * sends an unknown id back to the grid. Renders the same `CollectionView` as `/`
 * with the record drawer open.
 */
export const Route = createFileRoute("/records/$id")({
	loader: async ({ context, params }) => {
		const data = await context.queryClient.ensureQueryData(
			publicRecordsQueryOptions,
		);
		const id = parseRecordIdParam(params.id);
		const record = id == null ? undefined : data.find((r) => r.id === id);
		if (!record) throw redirect({ to: "/" });
		const canonical = recordIdParam(record);
		if (params.id !== canonical)
			throw redirect({ to: "/records/$id", params: { id: canonical } });
		return { id: record.id };
	},
	component: RecordPage,
});

function RecordPage() {
	const { id } = Route.useLoaderData();
	return <CollectionView selectedId={id} />;
}
