import { Link } from "@tanstack/react-router";

/**
 * The collection's links, in the bottom-right corner (the filters take the
 * bottom-left and the search the top-left) on both layouts — with a way to
 * the other one. See `[data-wall-corner]` in styles.css.
 */
export function WallCorners({ layout }: { layout: "wall" | "grid" }) {
	return (
		<nav
			data-wall-corner="footer"
			className="items-center gap-3 font-mono text-[11px] text-muted-foreground"
		>
			<Link
				to={layout === "wall" ? "/grid" : "/"}
				className="underline-offset-4 hover:text-foreground hover:underline"
			>
				{layout === "wall" ? "Grid view" : "Wall view"}
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
