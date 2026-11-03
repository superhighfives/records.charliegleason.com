import { Link } from "@tanstack/react-router";

/**
 * On the wall the page doesn't scroll, so the bits it used to scroll past
 * sit in its corners instead: the title (top-left, once the wall has moved
 * and the hero has gone — a link back to the start), and the footer's links
 * (bottom-right, always). The filters take the bottom-left and the search
 * the top-right; see `[data-wall-corner]` in styles.css.
 */
export function WallCorners({ count }: { count: number }) {
	return (
		<>
			<Link
				to="/"
				reloadDocument
				data-wall-corner="title"
				className="flex flex-col leading-tight"
				title="Back to the start"
			>
				<span className="font-serif text-lg font-medium tracking-tight">
					Records
				</span>
				<span className="font-mono text-[11px] text-muted-foreground">
					{count} · Charlie Gleason
				</span>
			</Link>
			<nav
				data-wall-corner="footer"
				className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground"
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
		</>
	);
}
