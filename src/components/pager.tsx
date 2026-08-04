import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/**
 * Back/next paging control: two arrow buttons around an "index / total"
 * counter. Shared by anything that steps through a list one item at a time —
 * the admin record pager and image editor, and the Amazon import comparison
 * modal. `noun` customises the button labels/titles (e.g. "record", "pairing")
 * for screen readers and the hover tooltip.
 */
export function Pager({
	index,
	total,
	hasPrev,
	hasNext,
	onPrev,
	onNext,
	noun = "item",
	className,
}: {
	index: number;
	total: number;
	hasPrev: boolean;
	hasNext: boolean;
	onPrev: () => void;
	onNext: () => void;
	noun?: string;
	className?: string;
}) {
	// Nothing to page through — a lone item, or the list hasn't loaded yet.
	if (total <= 1 || index < 0) return null;
	return (
		<div className={cn("flex shrink-0 items-center gap-2", className)}>
			<Button
				type="button"
				variant="outline"
				size="icon-sm"
				disabled={!hasPrev}
				onClick={onPrev}
				aria-label={`Previous ${noun}`}
				title={`Previous ${noun} (←)`}
			>
				<ChevronLeft />
			</Button>
			<span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
				{index + 1} / {total}
			</span>
			<Button
				type="button"
				variant="outline"
				size="icon-sm"
				disabled={!hasNext}
				onClick={onNext}
				aria-label={`Next ${noun}`}
				title={`Next ${noun} (→)`}
			>
				<ChevronRight />
			</Button>
		</div>
	);
}
