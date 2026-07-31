import { cn } from "#/lib/utils";

/**
 * Shown when a record looks like a duplicate of another one currently in the
 * collection — a live check against the whole collection (same Discogs master /
 * release / artist+title; see `likelyDuplicateOf`). Sits alongside the StatusBadge
 * so a freshly captured sleeve announces itself as a dupe without opening the record.
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
