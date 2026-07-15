import { cn } from "#/lib/utils";

/**
 * Stand-in for a record with no cover image — a stylised vinyl disc peeking from a
 * sleeve, drawn in muted strokes so it reads as "no artwork yet" rather than a broken
 * image. Fills its square container; the caller supplies the aspect box. Shared by the
 * homepage grid tile and the detail drawer so the fallback looks the same everywhere.
 */
export function SleevePlaceholder({ className }: { className?: string }) {
	return (
		<div
			className={cn(
				"flex size-full items-center justify-center bg-card text-muted-foreground/35",
				className,
			)}
		>
			<svg
				viewBox="0 0 100 100"
				className="size-3/5"
				fill="none"
				stroke="currentColor"
				aria-hidden="true"
			>
				<title>No cover</title>
				{/* Vinyl disc + grooves */}
				<circle cx="50" cy="50" r="37" strokeWidth="1.25" />
				<circle cx="50" cy="50" r="30" strokeWidth="0.75" opacity="0.6" />
				<circle cx="50" cy="50" r="24" strokeWidth="0.75" opacity="0.6" />
				<circle cx="50" cy="50" r="18" strokeWidth="0.75" opacity="0.6" />
				{/* Centre label + spindle hole */}
				<circle
					cx="50"
					cy="50"
					r="12"
					strokeWidth="1.25"
					fill="currentColor"
					fillOpacity="0.12"
				/>
				<circle cx="50" cy="50" r="1.75" fill="currentColor" stroke="none" />
			</svg>
		</div>
	);
}
