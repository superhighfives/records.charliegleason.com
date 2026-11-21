import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { countRecordAlerts } from "#/lib/record-alerts";
import { queueMissingValues } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/**
 * Everything in the collection that needs attention, each with the list filter or
 * action that deals with it. Sits beside the queue menu and hides when there is
 * nothing to do.
 */
export function AlertsMenu() {
	const { data: records } = useQuery(recordsQueryOptions);
	const counts = useMemo(() => countRecordAlerts(records ?? []), [records]);
	const queryClient = useQueryClient();

	const fetchValues = useMutation({
		mutationFn: () => queueMissingValues(),
		onSuccess: async ({ count }) => {
			toast.success(
				count > 0
					? `Fetching ${plural(count, "value", "values")} from Discogs. Follow them in the queue menu.`
					: "Every pinned pressing already has a value.",
			);
			await queryClient.invalidateQueries({ queryKey: ["records"] });
		},
		onError: () => toast.error("Couldn't start fetching values. Try again."),
	});

	const total =
		counts.brokenLinks +
		counts.analysisFailed +
		counts.imageFailed +
		counts.unmatched +
		counts.needsPressing +
		counts.valuesToFetch;
	if (total === 0) return null;

	const errors =
		counts.brokenLinks + counts.analysisFailed + counts.imageFailed;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Needs attention"
				className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<TriangleAlertIcon
					className={
						errors > 0
							? "size-4 text-red-600 dark:text-red-400"
							: "size-4 text-amber-600 dark:text-amber-400"
					}
				/>
				<span className="tabular-nums">{total}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72">
				{counts.brokenLinks > 0 && (
					<AlertLink
						search={{ assign: "broken" }}
						tone="error"
						text={`${plural(counts.brokenLinks, "broken Discogs link", "broken Discogs links")}`}
						action="Fix"
					/>
				)}
				{counts.analysisFailed > 0 && (
					<AlertLink
						search={{ f: "failed" }}
						tone="error"
						text={`${plural(counts.analysisFailed, "analysis", "analyses")} failed`}
						action="Show"
					/>
				)}
				{counts.imageFailed > 0 && (
					<AlertLink
						search={{ f: "genFailed" }}
						tone="error"
						text={`${plural(counts.imageFailed, "cover", "covers")} failed to apply`}
						action="Show"
					/>
				)}
				{counts.unmatched > 0 && (
					<AlertLink
						search={{ assign: "unmatched" }}
						text={`${plural(counts.unmatched, "record has", "records have")} no album`}
						action="Assign"
					/>
				)}
				{counts.needsPressing > 0 && (
					<AlertLink
						search={{ f: "matched,albumOnly" }}
						text={`${plural(counts.needsPressing, "record needs", "records need")} a pressing`}
						action="Show"
					/>
				)}
				{counts.valuesToFetch > 0 && (
					<DropdownMenuItem
						disabled={fetchValues.isPending}
						onSelect={() => fetchValues.mutate()}
						className="min-h-9 justify-between gap-3"
					>
						<span>
							{plural(counts.valuesToFetch, "value", "values")} to fetch
						</span>
						<span className="text-xs text-muted-foreground">
							{fetchValues.isPending ? "Queuing…" : "Fetch"}
						</span>
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function AlertLink({
	search,
	text,
	action,
	tone,
}: {
	search: { f?: string; assign?: "broken" | "unmatched" };
	text: string;
	action: string;
	tone?: "error";
}) {
	return (
		<DropdownMenuItem asChild className="min-h-9 justify-between gap-3">
			<Link to="/admin" search={search}>
				<span
					className={tone === "error" ? "text-red-600 dark:text-red-400" : ""}
				>
					{text}
				</span>
				<span className="text-xs text-muted-foreground">{action}</span>
			</Link>
		</DropdownMenuItem>
	);
}
