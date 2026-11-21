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

// Each job type gets its own pill colour, so a long log scans by type at a glance.
const KINDS: {
	[K in ActivityEvent["kind"]]: { label: string; className: string };
} = {
	analyze: {
		label: "Analyze",
		className: "border-sky-500/40 text-sky-600 dark:text-sky-400",
	},
	professional: {
		label: "Apply",
		className: "border-violet-500/40 text-violet-600 dark:text-violet-400",
	},
	value: {
		label: "Value",
		className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
	},
	color: {
		label: "Color",
		className: "border-amber-500/40 text-amber-600 dark:text-amber-400",
	},
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
	const [errorsOnly, setErrorsOnly] = useState(false);
	const { data: shown = [], isPending } = useQuery(
		jobEventsQueryOptions(errorsOnly),
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
							<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
								<span
									className={cn(
										"inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-medium",
										KINDS[e.kind].className,
									)}
								>
									{KINDS[e.kind].label}
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
								<MessageText text={e.message} />
							</p>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** A job message, with each "release 123" linked to that release on Discogs. */
function MessageText({ text }: { text: string }) {
	return text.split(/(\brelease \d+\b)/).map((part, i) => {
		const id = /^release (\d+)$/.exec(part)?.[1];
		return id ? (
			<a
				// biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
				key={i}
				href={`https://www.discogs.com/release/${id}`}
				target="_blank"
				rel="noreferrer"
				className="underline underline-offset-4"
			>
				{part}
			</a>
		) : (
			part
		);
	});
}
