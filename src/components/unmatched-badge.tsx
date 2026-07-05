import { SearchX } from "lucide-react";

import { cn } from "#/lib/utils";

/**
 * Shown when a record was identified from its cover but the background analysis
 * couldn't attach a Discogs release (no `discogsId`) — Discogs either had no
 * match or transiently failed. Sits alongside the StatusBadge so an unmatched
 * capture announces that it still needs a release picked, without opening it.
 */
export function UnmatchedBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200",
				className,
			)}
			title="Couldn’t find a matching Discogs release — search or paste a URL to link one"
		>
			<SearchX className="size-3" />
			Unmatched
		</span>
	);
}
