import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import type { Record } from "#/db/schema";
import { setManualValue } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";
import { effectiveValue, formatMoney } from "#/lib/value";

/**
 * The list's value cell, editable in place: click the value (or "Add value") to type
 * a manual value in USD. Enter or leaving the field saves, Escape cancels, and an
 * empty field clears the manual value so the Discogs figure shows again. The saved
 * row goes straight into the list cache, so filters such as "No price" update at once.
 */
export function ValueCell({ record }: { record: Record }) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<string | null>(null);
	const value = effectiveValue(record);
	const currency = record.discogsValueCurrency ?? "USD";

	const save = useMutation({
		mutationFn: (manual: number | null) =>
			setManualValue({ data: { id: record.id, value: manual } }),
		onSuccess: (row) => {
			if (!row) return;
			queryClient.setQueryData(recordsQueryOptions.queryKey, (list) =>
				list?.map((r) => (r.id === row.id ? row : r)),
			);
		},
		onError: () => toast.error("Couldn't save the value. Try again."),
	});

	const commit = () => {
		if (draft == null) return;
		const text = draft.trim().replace(/^\$/, "");
		setDraft(null);
		const manual = text === "" ? null : Number(text);
		if (manual != null && !(Number.isFinite(manual) && manual >= 0)) {
			toast.error("Enter an amount like 25 or 25.50, or leave it empty.");
			return;
		}
		if (manual === record.manualValue) return;
		save.mutate(manual);
	};

	if (draft != null) {
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: opened by an explicit click on this cell
				autoFocus
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") commit();
					if (e.key === "Escape") setDraft(null);
				}}
				onBlur={commit}
				inputMode="decimal"
				placeholder={value != null ? formatMoney(value, currency) : "USD"}
				aria-label={`Value of ${record.artist} — ${record.title}, in USD`}
				className="h-7 w-24 rounded-md border border-input bg-transparent px-2 text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
			/>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setDraft(record.manualValue?.toString() ?? "")}
			disabled={save.isPending}
			title={
				record.manualValue != null
					? "Confirmed value. Click to edit"
					: value != null
						? "Estimated from Discogs. Click to set your own"
						: "Click to add a value"
			}
			className={cn(
				"rounded-md px-1 tabular-nums hover:bg-accent disabled:opacity-50",
				value == null && "text-muted-foreground",
			)}
		>
			{value != null ? formatMoney(value, currency) : "Add value"}
		</button>
	);
}
