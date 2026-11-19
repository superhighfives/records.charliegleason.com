import { useLayoutEffect } from "react";

/**
 * Makes the page the wall's: sets `data-wall` on the root, which gives it the
 * wall's fixed, unscrolling black / white surface and drops the grid's page
 * chrome (see `[data-wall]` in styles.css). A layout effect, from the first
 * paint, so it holds whether the scene is up, still loading, or not drawn at
 * all because nothing matches — not just once `WallGrid` has mounted.
 */
export function useWallPage(wallMode: boolean) {
	useLayoutEffect(() => {
		if (!wallMode) return;
		const root = document.documentElement;
		root.dataset.wall = "";
		return () => {
			delete root.dataset.wall;
			// Set by `WallScene` once it's up; cleared here, on leaving the wall,
			// rather than when the scene unmounts — an empty result unmounts it,
			// and clearing it then would put the spinner back for good.
			delete root.dataset.wallReady;
		};
	}, [wallMode]);
}
