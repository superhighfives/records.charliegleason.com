import { Link } from "@tanstack/react-router";

/**
 * On the wall the page doesn't scroll, so the footer's links sit in its
 * bottom-right corner instead (the filters take the bottom-left and the
 * search the top-left); see `[data-wall-corner]` in styles.css.
 */
export function WallCorners() {
	return (
		<nav
			data-wall-corner="footer"
			className="items-center gap-3 font-mono text-[11px] text-muted-foreground"
		>
			<Link
				to="/grid"
				className="underline-offset-4 hover:text-foreground hover:underline"
			>
				Grid view
			</Link>
			<span aria-hidden>·</span>
			<a
				href="https://charliegleason.com"
				className="underline-offset-4 hover:text-foreground hover:underline"
			>
				charliegleason.com
			</a>
		</nav>
	);
}
