import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Switch } from "#/components/ui/switch";
import type { ActivityEvent } from "#/lib/activity";
import { jobEventsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/admin/activity")({
	component: ActivityPage,
});

const KIND_LABELS: { [K in ActivityEvent["kind"]]: string } = {
	analyze: "Analyze",
	professional: "Apply",
	value: "Value",
	color: "Color",
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	second: "2-digit",
});

/**
 * What the background jobs did, newest first: each analysis, Apply, value fetch
 * and color texture, and every failed attempt with its error. Refreshes while open.
 */
function ActivityPage() {
	const { data: events, isPending } = useQuery(jobEventsQueryOptions);
	const [errorsOnly, setErrorsOnly] = useState(false);
	const shown = (events ?? []).filter(
		(e) => !errorsOnly || e.level === "error",
	);

	return (
		<div className="mx-auto w-full max-w-2xl space-y-4">
			<header className="flex flex-wrap items-end justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-lg font-semibold">Activity</h1>
					<p className="text-sm text-muted-foreground">
						What the background jobs did in the last two weeks, newest first.
					</p>
				</div>
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Switch
						id="errors-only"
						checked={errorsOnly}
						onCheckedChange={setErrorsOnly}
					/>
					<label htmlFor="errors-only">Errors only</label>
				</div>
			</header>

			{isPending ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : shown.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					{errorsOnly ? "No errors." : "Nothing has run yet."}
				</p>
			) : (
				<ul className="divide-y divide-border rounded-md border border-border">
					{shown.map((e) => (
						<li key={e.id} className="space-y-0.5 px-3 py-2.5 text-sm">
							<div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
								<span className="font-medium text-foreground">
									{KIND_LABELS[e.kind]}
								</span>
								{e.recordId != null && (
									<Link
										to="/admin/records/$id"
										params={{ id: String(e.recordId) }}
										className="truncate underline underline-offset-4 hover:text-foreground"
									>
										{e.artist
											? `${e.artist} — ${e.title}`
											: `Record ${e.recordId}`}
									</Link>
								)}
								{e.createdAt && (
									<time
										dateTime={e.createdAt.toISOString()}
										className="ml-auto tabular-nums"
									>
										{timeFormat.format(e.createdAt)}
									</time>
								)}
							</div>
							<p
								className={cn(
									"break-words",
									e.level === "error" && "text-destructive",
								)}
							>
								{e.message}
							</p>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
