import { Link } from "@tanstack/react-router";

/**
 * The collection's links — a way to the other layout, and the main site —
 * at the end of the bottom bar, after the filters (see `[data-wall-corner]`
 * in styles.css).
 */
export function WallCorners({ layout }: { layout: "wall" | "table" }) {
	return (
		<nav
			aria-label="Collection links"
			data-wall-corner="footer"
			className="items-center gap-3 font-mono text-[11px] text-muted-foreground"
		>
			<Link
				to={layout === "wall" ? "/table" : "/"}
				className="underline-offset-4 hover:text-foreground hover:underline"
			>
				{layout === "wall" ? "Table view" : "Wall view"}
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
