import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { RecordForm } from "#/components/record-form";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type { Record } from "#/db/schema";
import type { DiscogsCandidate } from "#/lib/discogs";
import type { RecordFormValues } from "#/lib/record-schema";
import {
	getDiscogsRelease,
	publishRecord,
	reprocessRecord,
	searchDiscogs,
} from "#/lib/records";
import { recordQueryOptions, recordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/admin/records/$id")({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(recordQueryOptions(Number(params.id))),
	component: RecordDetail,
});

function parseCandidates(json: string | null): Array<DiscogsCandidate> {
	if (!json) return [];
	try {
		return JSON.parse(json) as Array<DiscogsCandidate>;
	} catch {
		return [];
	}
}

/** Build form defaults from the record, overlaying a freshly picked Discogs release. */
function toForm(
	record: Record,
	picked: DiscogsCandidate | null,
): RecordFormValues {
	return {
		artist: picked?.artist || record.artist,
		title: picked?.title || record.title,
		year: (picked?.year ?? record.year)?.toString() ?? "",
		label: picked?.label ?? record.label ?? "",
		format: record.format ?? "LP",
		genre: picked?.genre ?? record.genre ?? "",
		pitchforkScore: record.pitchforkScore?.toString() ?? "",
		notes: record.notes ?? "",
	};
}

/** Expanded details for a selected Discogs candidate (fetched on demand). */
function CandidateDetail({ discogsId }: { discogsId: string }) {
	const { data, isLoading } = useQuery({
		queryKey: ["discogs-release", discogsId] as const,
		queryFn: () => getDiscogsRelease({ data: discogsId }),
		staleTime: 5 * 60 * 1000,
	});

	if (isLoading) {
		return (
			<p className="px-3 pb-3 text-xs text-muted-foreground">
				Loading release details…
			</p>
		);
	}
	if (!data) {
		return (
			<p className="px-3 pb-3 text-xs text-muted-foreground">
				No extra details available.
			</p>
		);
	}

	const meta = [data.formats, data.country, data.released]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className="space-y-3 border-t bg-accent/30 px-3 py-3">
			{meta && <p className="text-sm text-muted-foreground">{meta}</p>}
			{data.styles.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{data.styles.map((s) => (
						<span key={s} className="rounded-full bg-muted px-2 py-0.5 text-xs">
							{s}
						</span>
					))}
				</div>
			)}
			{data.tracklist.length > 0 && (
				<ol className="space-y-0.5">
					{data.tracklist.map((t) => (
						<li
							key={`${t.position}-${t.title}`}
							className="flex gap-2 text-xs text-muted-foreground"
						>
							<span className="w-8 shrink-0 tabular-nums">{t.position}</span>
							<span className="flex-1 text-foreground">{t.title}</span>
							{t.duration && <span className="tabular-nums">{t.duration}</span>}
						</li>
					))}
				</ol>
			)}
			{data.notes && (
				<p className="line-clamp-3 whitespace-pre-line text-xs text-muted-foreground">
					{data.notes}
				</p>
			)}
		</div>
	);
}

function RecordDetail() {
	const { id } = Route.useParams();
	const recordId = Number(id);
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const { data: record } = useQuery({
		...recordQueryOptions(recordId),
		// Poll while the background analysis is in flight.
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "pending" || status === "processing" ? 2000 : false;
		},
	});

	const [picked, setPicked] = useState<DiscogsCandidate | null>(null);
	const [results, setResults] = useState<Array<DiscogsCandidate> | null>(null);
	const [query, setQuery] = useState({ artist: "", title: "" });
	const [showSearch, setShowSearch] = useState(false);

	const invalidate = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: recordsQueryOptions.queryKey }),
			queryClient.invalidateQueries({
				queryKey: recordQueryOptions(recordId).queryKey,
			}),
		]);

	const search = useMutation({
		mutationFn: (q: { artist: string; title: string }) =>
			searchDiscogs({ data: q }),
		onSuccess: setResults,
	});

	const retry = useMutation({
		mutationFn: () => reprocessRecord({ data: recordId }),
		onSuccess: invalidate,
	});

	if (!record) {
		return <p className="text-muted-foreground">Record not found.</p>;
	}

	const candidates = results ?? parseCandidates(record.candidatesJson);
	const inFlight =
		record.status === "pending" || record.status === "processing";
	const heading =
		record.artist || record.title
			? `${record.artist || "Unknown"} — ${record.title || "Untitled"}`
			: "Captured record";

	return (
		<div className="max-w-2xl space-y-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<Link
						to="/admin"
						className="text-sm text-muted-foreground underline underline-offset-4"
					>
						← Collection
					</Link>
					<h1 className="mt-1 text-2xl font-semibold">{heading}</h1>
				</div>
				<StatusBadge status={record.status} className="shrink-0" />
			</div>

			{/* Photos: the iPhone capture, plus the sourced cover once we have one. */}
			<div className="flex gap-3">
				{record.capturePhotoKey && (
					<figure className="space-y-1">
						<img
							src={`/api/photos/${record.capturePhotoKey}`}
							alt="Original capture"
							className="size-32 rounded-md border object-cover"
						/>
						<figcaption className="text-xs text-muted-foreground">
							Capture
						</figcaption>
					</figure>
				)}
				{record.coverImageKey && (
					<figure className="space-y-1">
						<img
							src={`/api/photos/${record.coverImageKey}`}
							alt="Sourced cover"
							className="size-32 rounded-md border object-cover"
						/>
						<figcaption className="text-xs text-muted-foreground">
							Cover
						</figcaption>
					</figure>
				)}
			</div>

			{record.captureContext && (
				<p className="text-sm text-muted-foreground">
					<span className="font-medium text-foreground">Context:</span>{" "}
					{record.captureContext}
				</p>
			)}

			{/* In-flight: just wait and poll. */}
			{inFlight && (
				<div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
					Analyzing the photo in the background — reading the cover, matching
					Discogs, scoring on Pitchfork. This page updates itself when it’s
					ready.
				</div>
			)}

			{/* Failed: show the error and let the user retry or fill it in by hand. */}
			{record.status === "failed" && (
				<div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4">
					<p className="text-sm text-red-800">
						<span className="font-medium">Analysis failed.</span>{" "}
						{record.error ?? "Unknown error."}
					</p>
					<Button
						type="button"
						variant="outline"
						disabled={retry.isPending}
						onClick={() => retry.mutate()}
					>
						{retry.isPending ? "Re-queuing…" : "Retry analysis"}
					</Button>
				</div>
			)}

			{/* Review / failed / complete: confirm, edit, re-pick, publish. */}
			{!inFlight && (
				<div className="space-y-4">
					{record.confidence != null && (
						<p className="text-sm text-muted-foreground">
							Identified with {Math.round(record.confidence * 100)}% confidence.
							{record.status === "review"
								? " Confirm the details and pick the right Discogs release before publishing."
								: ""}
						</p>
					)}

					{/* Wrong match? reveal the manual Discogs search. */}
					<button
						type="button"
						onClick={() => setShowSearch((v) => !v)}
						className="text-sm text-muted-foreground underline underline-offset-4"
					>
						{showSearch ? "Hide Discogs search" : "Wrong match? Search Discogs"}
					</button>

					{showSearch && (
						<div className="flex items-end gap-2">
							<div className="flex-1 space-y-1">
								<label
									htmlFor="q-artist"
									className="text-xs text-muted-foreground"
								>
									Artist
								</label>
								<Input
									id="q-artist"
									value={query.artist}
									onChange={(e) =>
										setQuery((q) => ({ ...q, artist: e.target.value }))
									}
								/>
							</div>
							<div className="flex-1 space-y-1">
								<label
									htmlFor="q-title"
									className="text-xs text-muted-foreground"
								>
									Title
								</label>
								<Input
									id="q-title"
									value={query.title}
									onChange={(e) =>
										setQuery((q) => ({ ...q, title: e.target.value }))
									}
								/>
							</div>
							<Button
								type="button"
								variant="outline"
								disabled={search.isPending}
								onClick={() => search.mutate(query)}
							>
								{search.isPending ? "…" : "Search"}
							</Button>
						</div>
					)}

					{/* Candidate pick-list. */}
					{candidates.length > 0 && (
						<ul className="divide-y rounded-md border">
							{candidates.map((c) => {
								const active =
									picked?.discogsId === c.discogsId ||
									(!picked && record.discogsId === c.discogsId);
								return (
									<li key={c.discogsId}>
										<button
											type="button"
											onClick={() => setPicked(active ? null : c)}
											className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
												active ? "bg-accent" : "hover:bg-accent/50"
											}`}
										>
											{c.thumb ? (
												<img
													src={c.thumb}
													alt=""
													className="size-10 shrink-0 rounded object-cover"
												/>
											) : (
												<div className="size-10 shrink-0 rounded bg-muted" />
											)}
											<span className="min-w-0 flex-1">
												<span className="block truncate">
													<span className="font-medium">{c.artist}</span> —{" "}
													{c.title}
													{c.year ? ` (${c.year})` : ""}
												</span>
												{[c.format, c.country, c.label, c.catno].some(
													Boolean,
												) && (
													<span className="block truncate text-xs text-muted-foreground">
														{[c.format, c.country, c.label, c.catno]
															.filter(Boolean)
															.join(" · ")}
													</span>
												)}
											</span>
											{active && <span className="shrink-0 text-xs">✓</span>}
										</button>
										{active && <CandidateDetail discogsId={c.discogsId} />}
									</li>
								);
							})}
						</ul>
					)}

					<RecordForm
						key={picked?.discogsId ?? record.discogsId ?? "record"}
						defaultValues={toForm(record, picked)}
						submitLabel={
							record.status === "complete" ? "Save changes" : "Save & publish"
						}
						onSubmit={async (input) => {
							await publishRecord({
								data: {
									id: recordId,
									data: input,
									discogsId: picked?.discogsId ?? record.discogsId ?? null,
									discogsUrl: picked?.discogsUrl ?? record.discogsUrl ?? null,
								},
							});
							await invalidate();
							navigate({ to: "/admin" });
						}}
					/>
				</div>
			)}
		</div>
	);
}
