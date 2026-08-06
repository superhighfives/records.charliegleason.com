import {
	isMatteAuditReasonCode,
	type MatteAuditReasonCode,
} from "#/lib/photo-processing";
import { cn } from "#/lib/utils";

/** Human labels for each `professionalMatteAuditReason` code (see `assessMatteQuality`
 * in photo-processing.ts). A missing key here is a compile error, so a new reason code
 * always ships with a label. */
const REASON_LABELS: Record<MatteAuditReasonCode, string> = {
	tint: "colour cast",
	edge: "edge overrun",
	sparse: "under-cropped (mostly transparent)",
	inside: "hole inside the cover",
};

/** Turn a comma-joined `professionalMatteAuditReason` ("tint,edge") into a human,
 * comma-separated description ("colour cast, edge overrun"). */
export function describeMatteAuditReason(reason: string): string {
	return reason
		.split(",")
		.map((code) => (isMatteAuditReasonCode(code) ? REASON_LABELS[code] : code))
		.join(", ");
}

/**
 * Shown when the "Audit covers" sweep (`src/lib/matte-audit.ts`) flagged this record's
 * stored matte for a likely defect — the regression classes the Parachutes matte fix and
 * the under-crop/punch-through heuristics address, surfaced here for records whose bad
 * render predates the fix. Reads red (unlike the amber `MatteFallbackBadge`) since, unlike
 * a merely lo-fi fallback, this is a specific visual defect worth reviewing. `reason` is
 * the comma-joined `professionalMatteAuditReason` — see `MATTE_AUDIT_REASON_CODES` in
 * photo-processing.ts for the full set, or any combination.
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
			title={`Cover audit flagged this matte (${describeMatteAuditReason(reason)}) — review it and "Retry flagged mattes" if it needs a re-cut`}
		>
			Matte flagged
		</span>
	);
}
