import { Link } from "@tanstack/react-router";
import { Check, Ellipsis, ExternalLink } from "lucide-react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";

/**
 * The "…" at the end of the bottom bar, after the filters: a menu with the
 * two views and a link to the main site (see `[data-view-menu]` in
 * styles.css).
 */
export function ViewMenu({ layout }: { layout: "wall" | "table" }) {
	return (
		<div data-view-menu>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger className="filter-chip" aria-label="More">
					<Ellipsis aria-hidden="true" className="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent side="top" align="end" className="min-w-44">
					<DropdownMenuItem asChild>
						<Link to="/">
							Wall view
							{layout === "wall" && <Check className="ml-auto size-4" />}
						</Link>
					</DropdownMenuItem>
					<DropdownMenuItem asChild>
						<Link to="/table">
							Table view
							{layout === "table" && <Check className="ml-auto size-4" />}
						</Link>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem asChild>
						<a href="https://charliegleason.com">
							charliegleason.com
							<ExternalLink className="ml-auto size-3.5 text-muted-foreground" />
						</a>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
