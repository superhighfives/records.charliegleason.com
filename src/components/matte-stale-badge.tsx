import { cn } from "#/lib/utils";

/**
 * Shown when a record carries a Magic (AI) matte from an earlier successful Apply
 * (`professionalAlphaSource === "ai"`) but its most recent Apply job failed
 * (`professionalJobStatus === "failed"`). The stored matte source describes the *last
 * completed* Apply, so on its own the "Magic matte" filter would imply an up-to-date
 * cutout — this flags that the matte predates the failed job and may not match the
 * current cover. Muted, not alarming: the red "Image failed" badge next to it already
 * carries the "needs action" weight, so this just adds the "why" while scanning.
 */
export function MatteStaleBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground",
				className,
			)}
			title="Magic matte from an earlier Apply — the latest job failed, so it predates the current cover and may be stale"
		>
			Magic matte · stale
		</span>
	);
}
