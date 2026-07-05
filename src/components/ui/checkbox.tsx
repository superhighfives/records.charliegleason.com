import { forwardRef, useEffect, useRef } from "react";

import { cn } from "#/lib/utils";

type CheckboxProps = Omit<
	React.InputHTMLAttributes<HTMLInputElement>,
	"type"
> & {
	/** Renders the mixed (dash) state for "some but not all selected". */
	indeterminate?: boolean;
};

/**
 * A styled checkbox built on a real native `<input>` (so keyboard, focus and form
 * semantics come for free). The input is stripped with `appearance-none` and we
 * paint the box fill + check/dash glyph on top, all stacked in a single grid cell
 * so every layer is perfectly centred. Native `<input>` has no markup for the
 * indeterminate state, so we drive that off the DOM property via a ref.
 *
 * Fill colours: near-black in light mode, brand yellow in dark mode — with the
 * glyph inverted to stay legible against each (matching the brand button).
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
	function Checkbox({ className, indeterminate, ...props }, forwardedRef) {
		const innerRef = useRef<HTMLInputElement>(null);

		useEffect(() => {
			if (innerRef.current) innerRef.current.indeterminate = !!indeterminate;
		}, [indeterminate]);

		return (
			<span
				className={cn(
					"relative inline-grid size-4 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1",
					className,
				)}
			>
				<input
					type="checkbox"
					ref={(node) => {
						innerRef.current = node;
						if (typeof forwardedRef === "function") forwardedRef(node);
						else if (forwardedRef) forwardedRef.current = node;
					}}
					className={cn(
						"peer size-4 cursor-pointer appearance-none rounded-[5px] border border-input bg-background shadow-xs transition-colors",
						"hover:border-foreground/50",
						// Filled (checked or mixed): black box in light mode…
						"checked:border-foreground checked:bg-foreground indeterminate:border-foreground indeterminate:bg-foreground",
						// …brand yellow in dark mode.
						"dark:checked:border-brand dark:checked:bg-brand dark:indeterminate:border-brand dark:indeterminate:bg-brand",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
						"disabled:cursor-not-allowed disabled:opacity-50",
					)}
					{...props}
				/>
				{/* Checkmark — visible only when fully checked. White on the black box
				    (light), near-black on the yellow box (dark). */}
				<svg
					aria-hidden="true"
					viewBox="0 0 12 12"
					fill="none"
					className="pointer-events-none size-3 text-background opacity-0 transition-opacity peer-checked:opacity-100 peer-indeterminate:opacity-0 dark:text-neutral-900"
				>
					<path
						d="M2.5 6.5 5 9l4.5-5"
						stroke="currentColor"
						strokeWidth={1.75}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
				{/* Dash — visible only in the mixed / indeterminate state. */}
				<span className="pointer-events-none h-0.5 w-2 rounded-full bg-background opacity-0 peer-indeterminate:opacity-100 dark:bg-neutral-900" />
			</span>
		);
	},
);
