import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { ThemeToggle } from "#/components/theme-toggle";
import { Input } from "#/components/ui/input";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

// Portraits borrowed from charliegleason.com — rotated like the avatars there.
const PORTRAITS = [
	"/photos/charlie-01.jpg",
	"/photos/charlie-03.jpg",
	"/photos/charlie-05.jpg",
	"/photos/charlie-07.jpg",
];

export const Route = createFileRoute("/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
	component: Home,
});

function Home() {
	const { data } = useSuspenseQuery(publicRecordsQueryOptions);
	const [search, setSearch] = useState("");

	// Pick a portrait client-side after mount to avoid an SSR hydration
	// mismatch (Math.random would differ between server and client render).
	const [portrait, setPortrait] = useState<string | null>(null);
	useEffect(() => {
		setPortrait(PORTRAITS[Math.floor(Math.random() * PORTRAITS.length)]);
	}, []);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return data;
		return data.filter((r) =>
			[r.artist, r.title, r.year]
				.filter(Boolean)
				.some((v) => String(v).toLowerCase().includes(q)),
		);
	}, [data, search]);

	return (
		<div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
			<header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
				<div className="flex items-center gap-4">
					<a
						href="https://charliegleason.com"
						className="block shrink-0"
						aria-label="charliegleason.com"
					>
						<span className="block size-14 overflow-hidden rounded-full border border-border ring-1 ring-brand/40">
							{portrait && (
								<img
									src={portrait}
									alt="Charlie Gleason"
									className="size-full object-cover"
									style={{ animation: "fade-in 400ms ease-out both" }}
								/>
							)}
						</span>
					</a>
					<div>
						<p className="kicker mb-1">The collection</p>
						<h1 className="text-3xl font-semibold tracking-tight">Records</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							<span className="font-medium text-foreground tabular-nums">
								{data.length}
							</span>{" "}
							records ·{" "}
							<a
								href="https://charliegleason.com"
								className="underline decoration-brand/60 underline-offset-4 hover:text-foreground"
							>
								charliegleason.com
							</a>
						</p>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<Input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search records…"
						className="w-full sm:w-64"
					/>
					<ThemeToggle />
				</div>
			</header>

			{data.length === 0 ? (
				<p className="text-muted-foreground">Nothing here yet.</p>
			) : filtered.length === 0 ? (
				<p className="text-muted-foreground">No records match “{search}”.</p>
			) : (
				<ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-4">
					{filtered.map((r) => (
						<li key={r.id} className="space-y-2">
							<div className="album-card aspect-square overflow-hidden rounded-md">
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
								<p
									className="truncate font-medium"
									title={r.title ?? undefined}
								>
									{r.title}
								</p>
								<p className="truncate text-muted-foreground">
									{r.artist}
									{r.year ? ` · ${r.year}` : ""}
								</p>
								{r.pitchforkScore != null && (
									<p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
										<span className="inline-block size-1.5 rounded-full bg-brand" />
										Pitchfork{" "}
										<span className="tabular-nums">{r.pitchforkScore}</span>
									</p>
								)}
							</div>
						</li>
					))}
				</ul>
			)}

			<footer className="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
				A corner of{" "}
				<a
					href="https://charliegleason.com"
					className="underline decoration-brand/60 underline-offset-4 hover:text-foreground"
				>
					charliegleason.com
				</a>{" "}
				· set in Geist Mono.
			</footer>
		</div>
	);
}
