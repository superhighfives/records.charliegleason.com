import type { Record } from "#/db/schema";
import { cn } from "#/lib/utils";

type Status = NonNullable<Record["status"]>;

const STYLES: Record2<Status, { label: string; className: string }> = {
	pending: {
		label: "Queued",
		className:
			"bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
	},
	processing: {
		label: "Analyzing…",
		className: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
	},
	review: {
		label: "Needs review",
		className:
			"bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
	},
	failed: {
		label: "Failed",
		className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
	},
	complete: {
		label: "Published",
		className:
			"bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
	},
};

// Local alias so we don't shadow the `Record` row type with TS's built-in.
type Record2<K extends string, V> = { [P in K]: V };

export function StatusBadge({
	status,
	className,
}: {
	status: Status | null;
	className?: string;
}) {
	const style = STYLES[status ?? "complete"];
	return (
		<span
			className={cn(
				"inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
				style.className,
				className,
			)}
		>
			{style.label}
		</span>
	);
}
