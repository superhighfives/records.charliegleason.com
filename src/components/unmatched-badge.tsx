import { cn } from "#/lib/utils";

/**
 * Shown when a record has neither an album (`masterId`) nor a release
 * (`discogsId`) linked yet — one of the two is the identity that makes a
 * record publishable, so an unmatched record still needs one picked. Sits
 * alongside the StatusBadge so it announces that without opening the record.
 */
export function UnmatchedBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center whitespace-nowrap rounded-full border border-amber-500/40 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400",
				className,
			)}
			title="No album or release linked yet — search or paste a Discogs master/release to make this publishable"
		>
			Unmatched
		</span>
	);
}
