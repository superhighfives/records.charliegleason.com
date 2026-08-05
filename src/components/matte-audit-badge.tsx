import { cn } from "#/lib/utils";

/**
 * Shown when the "Audit covers" sweep (`src/lib/matte-audit.ts`) flagged this record's
 * stored matte for a likely colour cast or edge-overrun — the regression classes the
 * Parachutes matte fix addressed, surfaced here for records whose bad render predates
 * the fix. Reads red (unlike the amber `MatteFallbackBadge`) since, unlike a merely
 * lo-fi fallback, this is a specific visual defect worth reviewing. `reason` is the
 * comma-joined `professionalMatteAuditReason` ("tint", "edge", or "tint,edge").
 */
export function MatteAuditBadge({
	reason,
	className,
}: {
	reason: string;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center whitespace-nowrap rounded-full border border-red-500/40 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400",
				className,
			)}
			title={`Cover audit flagged this matte (${reason}) — review it and "Retry flagged mattes" if it needs a re-cut`}
		>
			Matte flagged
		</span>
	);
}
