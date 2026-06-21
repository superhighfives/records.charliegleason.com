import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { RecordForm } from "#/components/record-form";
import { recordToFormValues } from "#/lib/record-schema";
import { updateRecord } from "#/lib/records";
import { recordQueryOptions, recordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/admin/records/$id/edit")({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(recordQueryOptions(Number(params.id))),
	component: EditRecord,
});

function EditRecord() {
	const { id } = Route.useParams();
	const recordId = Number(id);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: record } = useSuspenseQuery(recordQueryOptions(recordId));

	if (!record) {
		return <p className="text-muted-foreground">Record not found.</p>;
	}

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-semibold">
				Edit · {record.artist} — {record.title}
			</h1>
			<RecordForm
				defaultValues={recordToFormValues(record)}
				submitLabel="Save changes"
				onSubmit={async (data) => {
					await updateRecord({ data: { id: recordId, data } });
					await Promise.all([
						queryClient.invalidateQueries({
							queryKey: recordsQueryOptions.queryKey,
						}),
						queryClient.invalidateQueries({
							queryKey: recordQueryOptions(recordId).queryKey,
						}),
					]);
					navigate({ to: "/admin" });
				}}
			/>
		</div>
	);
}
