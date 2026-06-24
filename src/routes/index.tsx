import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { ThemeToggle } from "#/components/theme-toggle";
import { Input } from "#/components/ui/input";
import { publicRecordsQueryOptions } from "#/lib/records-queries";

// A little emoji mashup in the spirit of charliegleason.com — a few picked at
// random per page load. Leans musical, since this is a record collection.
const EMOJI = [
	"🎵",
	"🎶",
	"💿",
	"📀",
	"🎧",
	"🎸",
	"🎹",
	"🥁",
	"🎤",
	"🎷",
	"🎺",
	"🪕",
	"🎻",
	"📻",
	"📼",
	"🪩",
	"✨",
	"🔥",
	"🌈",
	"🦄",
	"👾",
	"🛸",
	"⚡️",
	"🍕",
];

function pickEmoji(): string[] {
	const count = 1 + Math.floor(Math.random() * 3); // 1–3
	const pool = [...EMOJI];
	const out: string[] = [];
	for (let i = 0; i < count && pool.length; i++) {
		out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
	}
	return out;
}

export const Route = createFileRoute("/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicRecordsQueryOptions),
	component: Home,
});

function Home() {
	const { data } = useSuspenseQuery(publicRecordsQueryOptions);
	const [search, setSearch] = useState("");

	// Pick the emoji mashup client-side after mount to avoid an SSR hydration
	// mismatch (Math.random would differ between server and client render).
	const [emoji, setEmoji] = useState<string[] | null>(null);
	useEffect(() => {
		setEmoji(pickEmoji());
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
		<div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
			<header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
				<div className="flex items-center gap-4">
					<a
						href="https://charliegleason.com"
						className="block shrink-0"
						aria-label="charliegleason.com"
					>
						<span className="flex size-14 items-center justify-center text-3xl">
							{emoji?.map((e, i) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: decorative, fixed per render
									key={i}
									className="-ml-1.5 first:ml-0"
									style={{
										transform: `rotate(${(i - (emoji.length - 1) / 2) * 12}deg)`,
										animation: "fade-in 400ms ease-out both",
									}}
								>
									{e}
								</span>
							))}
						</span>
					</a>
					<div>
						<p className="kicker mb-1">The collection</p>
						<h1 className="font-serif text-4xl font-semibold tracking-tight">
							Records
						</h1>
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
						<li key={r.id} className="group space-y-2">
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
							<div className="text-sm leading-snug">
								<p
									className="truncate font-serif text-base font-medium"
									title={r.title ?? undefined}
								>
									{r.title}
								</p>
								<p className="truncate font-serif text-muted-foreground">
									{r.artist}
									{r.year ? ` · ${r.year}` : ""}
								</p>
								{r.pitchforkScore != null && (
									<p className="mt-1 text-xs font-medium text-brand tabular-nums">
										{r.pitchforkScore}
										<span className="ml-1 font-normal text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100">
											on Pitchfork
										</span>
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
				· set in Fraunces &amp; Geist Mono.
			</footer>
		</div>
	);
}
