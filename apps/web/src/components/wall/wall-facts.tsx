import { ChevronLeft, ChevronRight } from "lucide-react";

import { numberToWords } from "#/lib/number-to-words";
import { cn } from "#/lib/utils";
import type { Featured } from "./hero-modes";

/**
 * `?hero=facts` (and `tour`): a small timeline fixed above the filters —
 * the fact being visited, a tick per fact, and previous / next. Before the
 * first step (or once the wall's been dragged away) it just says how many
 * there are. With no `onStep` (the tour, which steps itself) the ticks only
 * show where it's at.
 */
export function WallFacts({
	featured,
	step,
	onStep,
	hidden,
}: {
	featured: Featured[];
	step: number | null;
	onStep?: (step: number) => void;
	/** While a record's open: out of the panel's way. */
	hidden: boolean;
}) {
	const n = featured.length;
	if (n === 0) return null;
	const by = (d: 1 | -1) =>
		onStep?.(step == null ? (d > 0 ? 0 : n - 1) : (step + d + n) % n);
	const count = numberToWords(n);
	return (
		// biome-ignore lint/a11y/useSemanticElements: a labelled group of controls, not a form fieldset
		<div
			role="group"
			aria-label="Facts about the collection"
			className={cn("wall-facts", hidden && "is-hidden")}
		>
			<p className="wall-facts-caption" aria-live="polite">
				{step == null
					? `${count.charAt(0).toUpperCase()}${count.slice(1)} things about the collection`
					: featured[step]?.caption}
			</p>
			<div className="wall-facts-track">
				{onStep && (
					<button
						type="button"
						className="wall-facts-arrow"
						aria-label="Previous fact"
						onClick={() => by(-1)}
					>
						<ChevronLeft className="size-4" />
					</button>
				)}
				<ol>
					{featured.map((fact, i) => (
						<li key={fact.recordId}>
							{onStep ? (
								<button
									type="button"
									className="wall-facts-tick"
									aria-label={fact.caption}
									aria-current={i === step ? "step" : undefined}
									onClick={() => onStep(i)}
								/>
							) : (
								<span
									className="wall-facts-tick"
									aria-current={i === step ? "step" : undefined}
								/>
							)}
						</li>
					))}
				</ol>
				{onStep && (
					<button
						type="button"
						className="wall-facts-arrow"
						aria-label="Next fact"
						onClick={() => by(1)}
					>
						<ChevronRight className="size-4" />
					</button>
				)}
			</div>
		</div>
	);
}
