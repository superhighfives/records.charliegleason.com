import type { Record } from "#/db/schema";
import { cn } from "#/lib/utils";

type Status = NonNullable<Record["status"]>;

// Outlined pills — a coloured border + text on a transparent fill, matching the
// admin filter chips. One accent colour per status.
const STYLES: Record2<Status, { label: string; className: string }> = {
	pending: {
		label: "Queued",
		className: "border-amber-500/40 text-amber-600 dark:text-amber-400",
	},
	processing: {
		label: "Analyzing…",
		className: "border-blue-500/40 text-blue-600 dark:text-blue-400",
	},
	review: {
		label: "Unpublished",
		className: "border-purple-500/40 text-purple-600 dark:text-purple-400",
	},
	failed: {
		label: "Failed",
		className: "border-red-500/40 text-red-600 dark:text-red-400",
	},
	complete: {
		label: "Published",
		className: "border-green-500/40 text-green-600 dark:text-green-400",
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
				"inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
				style.className,
				className,
			)}
		>
			{style.label}
		</span>
	);
}
