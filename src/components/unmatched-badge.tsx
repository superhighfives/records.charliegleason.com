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
				"inline-flex items-center whitespace-nowrap rounded-full border border-amber-500/40 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400",
				className,
			)}
			title="Couldn’t find a matching Discogs release — search or paste a URL to link one"
		>
			Unmatched
		</span>
	);
}
