import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { inFlightQueryOptions } from "#/lib/records-queries";

/**
 * Header dropdown listing everything currently in flight — captures being analysed and
 * Apply jobs generating a photo — so the admin can kick off long jobs and walk away, then
 * jump back to any one from here. Polls via {@link inFlightQueryOptions}. The trigger hides
 * entirely when nothing's running, so it's invisible at rest.
 */
export function QueueMenu() {
	const { data } = useQuery(inFlightQueryOptions);
	const items = data ?? [];
	if (items.length === 0) return null;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`${items.length} job${items.length === 1 ? "" : "s"} in flight`}
				className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<Loader2 className="size-4 animate-spin" />
				<span className="tabular-nums">{items.length}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72">
				{items.map((item) => (
					<DropdownMenuItem key={item.id} asChild>
						<Link
							to="/admin/records/$id"
							params={{ id: String(item.id) }}
							className="gap-3"
						>
							<span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
								{item.thumbKey ? (
									<img
										src={`/api/photos/${item.thumbKey}`}
										alt=""
										className="size-full object-cover"
									/>
								) : (
									<Loader2 className="size-4 animate-spin text-muted-foreground" />
								)}
							</span>
							<span className="flex min-w-0 flex-col">
								<span className="truncate font-medium">
									{item.artist} — {item.title}
								</span>
								<span className="text-xs text-muted-foreground">
									{item.kind === "analyze"
										? "Analyzing capture"
										: "Generating photo"}
								</span>
							</span>
						</Link>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
