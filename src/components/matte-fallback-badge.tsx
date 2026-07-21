import { cn } from "#/lib/utils";

/**
 * Shown when a record's cover is live but its matte came from the free deterministic
 * edge-snap because the paid AI matte failed (`professionalAlphaSource === "deterministic"`).
 * Informational, not a failure — the cover is fine — so it reads amber and subtle. Lets you
 * spot which records could be upgraded (via "Retry AI matte") without opening each one.
 */
export function MatteFallbackBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center whitespace-nowrap rounded-full border border-amber-500/40 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400",
				className,
			)}
			title="Cover is live, but the matte used the deterministic fallback — the AI matte can be retried"
		>
			AI matte
		</span>
	);
}
