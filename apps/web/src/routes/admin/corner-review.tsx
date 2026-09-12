import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { cornerReviewQueueQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/admin/corner-review")({
	component: CornerReview,
});

// Confidence → dot colour, matching the editor's badge bands (confidenceBand in
// sleeve-detect-wasm). Inlined so this route doesn't import that value module (its dynamic
// wasm imports would be pulled into the client bundle).
function bandDot(confidence: number): string {
	if (confidence >= 0.75) return "bg-emerald-500";
	if (confidence >= 0.45) return "bg-amber-500";
	return "bg-red-500";
}

/**
 * The active-learning queue: auto-detected crops awaiting the admin's approval, lowest
 * confidence first. Correcting the least-confident ones both fixes the crops most likely to be
 * wrong and produces the highest-value labels for the next retrain. Each row deep-links straight
 * into the record's corner editor (`?edit=true`).
 */
function CornerReview() {
	const { data: queue, isLoading } = useQuery(cornerReviewQueueQueryOptions);

	return (
		<div className="mx-auto max-w-3xl space-y-4 p-4">
			<header className="space-y-1">
				<h1 className="text-lg font-semibold">Corner review</h1>
				<p className="text-sm text-muted-foreground">
					Auto-detected crops awaiting your approval, lowest confidence first —
					the best candidates to correct and feed the next retrain.
				</p>
			</header>

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : !queue?.length ? (
				<p className="text-sm text-muted-foreground">
					Nothing to review — every detected crop has been approved. 🎉
				</p>
			) : (
				<ul className="divide-y divide-border rounded-md border border-border">
					{queue.map((r) => {
						const confidence = r.detectionConfidence ?? 0;
						return (
							<li key={r.id}>
								<Link
									to="/admin/records/$id"
									params={{ id: String(r.id) }}
									search={{ edit: true }}
									className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50"
								>
									<img
										src={`/api/photos/${r.capturePhotoKey}`}
										alt=""
										loading="lazy"
										className="size-12 shrink-0 rounded bg-muted object-cover"
									/>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-medium">
											{r.artist} — {r.title}
										</p>
										<p className="text-xs text-muted-foreground">
											{r.detectionSource ?? "detected"}
										</p>
									</div>
									<span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
										<span
											className={cn("size-2 rounded-full", bandDot(confidence))}
											aria-hidden
										/>
										{Math.round(confidence * 100)}%
									</span>
								</Link>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
