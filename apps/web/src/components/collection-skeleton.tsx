/**
 * Route-level fallback for {@link CollectionView} (`_collection`'s
 * `pendingComponent`), and its font-loading gate (see `useFontsReady`). The
 * page's real loading moment is the hero statement writing itself in
 * (`CollectionHero`), so this is deliberately almost nothing: a blank page
 * in the background colour, so the statement appears onto calm space rather
 * than replacing a spinner. Screen readers still hear "Loading records…"
 * straight away; sighted users only see it if the wait runs long (a cold,
 * slow load — SSR normally has the data ready), when it fades in quietly
 * where the statement will appear. See `.loading-hint` in styles.css.
 */
export function CollectionSkeleton() {
	return (
		<div className="w-full px-4 py-10 sm:px-6">
			<output
				aria-live="polite"
				className="loading-hint mt-16 block font-mono text-muted-foreground text-xs sm:mt-20"
			>
				Loading records…
			</output>
		</div>
	);
}
