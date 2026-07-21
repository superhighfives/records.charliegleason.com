import { cn } from "#/lib/utils";

/**
 * Shown when a record's Apply (generation) job errored out and stayed failed after the
 * auto-retries (`professionalJobStatus === "failed"`). Unlike the amber matte-fallback
 * note, this needs action — the cover didn't regenerate — so it reads red and sits
 * alongside the StatusBadge to flag it while scanning the collection without opening it.
 */
export function GenerationFailedBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center whitespace-nowrap rounded-full border border-red-500/40 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400",
				className,
			)}
			title="Photo generation failed after retries — open the record and Apply again"
		>
			Gen failed
		</span>
	);
}
