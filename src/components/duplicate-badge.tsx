import { CopyCheck } from "lucide-react";

import { cn } from "#/lib/utils";

/**
 * Shown when the background analysis decided a record already exists in the
 * collection (see `duplicateOf` on the row). Sits alongside the StatusBadge so a
 * freshly captured sleeve announces itself as a dupe without opening the record.
 */
export function DuplicateBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-950 dark:text-orange-200",
				className,
			)}
			title="This release is already in your collection"
		>
			<CopyCheck className="size-3" />
			Duplicate
		</span>
	);
}
