import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { RecordForm } from "#/components/record-form";
import { emptyRecordForm } from "#/lib/record-schema";
import { createRecord } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/admin/records/new")({
	component: NewRecord,
});

function NewRecord() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-semibold">New record</h1>
			<RecordForm
				defaultValues={emptyRecordForm}
				submitLabel="Create record"
				onSubmit={async (data) => {
					await createRecord({ data });
					await queryClient.invalidateQueries({
						queryKey: recordsQueryOptions.queryKey,
					});
					navigate({ to: "/admin" });
				}}
			/>
		</div>
	);
}
