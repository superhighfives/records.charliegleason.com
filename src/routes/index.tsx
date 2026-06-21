import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { publicRecordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
	component: Home,
});

function Home() {
	const { data } = useSuspenseQuery(publicRecordsQueryOptions);

	return (
		<div className="mx-auto max-w-5xl p-6">
			<header className="mb-8 flex items-baseline justify-between">
				<div>
					<h1 className="text-3xl font-semibold">Records</h1>
					<p className="text-sm text-muted-foreground">
						{data.length} in the collection
					</p>
				</div>
				<Link to="/admin" className="text-sm underline underline-offset-4">
					Admin
				</Link>
			</header>

			{data.length === 0 ? (
				<p className="text-muted-foreground">Nothing here yet.</p>
			) : (
				<ul className="grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4">
					{data.map((r) => (
						<li key={r.id} className="space-y-2">
							<div className="aspect-square overflow-hidden rounded-md border bg-muted">
								{r.coverImageKey && (
									<img
										src={`/api/photos/${r.coverImageKey}`}
										alt={`${r.artist} — ${r.title}`}
										className="size-full object-cover"
										loading="lazy"
									/>
								)}
							</div>
							<div className="text-sm leading-tight">
								<p className="font-medium">{r.title}</p>
								<p className="text-muted-foreground">
									{r.artist}
									{r.year ? ` · ${r.year}` : ""}
								</p>
								{r.pitchforkScore != null && (
									<p className="text-xs text-muted-foreground">
										Pitchfork {r.pitchforkScore}
									</p>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
