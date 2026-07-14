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
				"inline-flex items-center whitespace-nowrap rounded-full border border-orange-500/40 px-2 py-0.5 text-xs font-medium text-orange-600 dark:text-orange-400",
				className,
			)}
			title="This release is already in your collection"
		>
			Duplicate
		</span>
	);
}
