import { useLocation } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";

import { isGridPath } from "#/lib/records-path";

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
 *
 * On the wall it's {@link WallLoading} instead, so the wall's black / white
 * is there from the first paint.
 */
export function CollectionSkeleton() {
	const grid = useLocation({ select: (l) => isGridPath(l.pathname) });
	if (!grid) return <WallLoading />;
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

/**
 * The wall while it loads: the wall's own black / white, edge to edge, with
 * a spinner in the middle (if the wait runs long — see `.loading-hint`).
 * Gone once the scene is up (`data-wall-ready`, see `.wall-loading`).
 */
export function WallLoading() {
	return (
		<div className="wall-loading">
			<output aria-live="polite" className="loading-hint">
				<LoaderCircle
					aria-hidden
					className="size-5 animate-spin"
					strokeWidth={1.75}
				/>
				<span className="sr-only">Loading records…</span>
			</output>
		</div>
	);
}
