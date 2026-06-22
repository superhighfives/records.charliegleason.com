import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { RecordForm } from "#/components/record-form";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	analyzePhoto,
	type RecordSuggestion,
	searchDiscogs,
} from "#/lib/analyze";
import type { DiscogsCandidate } from "#/lib/discogs";
import type { RecordFormValues } from "#/lib/record-schema";
import { createRecord } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/admin/capture")({ component: Capture });

/** Build form defaults from either a picked Discogs candidate or the AI suggestion. */
function toForm(
	s: RecordSuggestion,
	picked: DiscogsCandidate | null,
): RecordFormValues {
	return {
		artist: picked?.artist || s.artist,
		title: picked?.title || s.title,
		year: (picked?.year ?? s.year)?.toString() ?? "",
		label: picked?.label ?? s.label ?? "",
		format: "LP",
		genre: picked?.genre ?? s.genre ?? "",
		pitchforkScore: s.pitchforkScore?.toString() ?? "",
		notes: "",
	};
}

function readFile(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function Capture() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [preview, setPreview] = useState<string | null>(null);
	const [mediaType, setMediaType] = useState("image/jpeg");
	const [suggestion, setSuggestion] = useState<RecordSuggestion | null>(null);
	const [candidates, setCandidates] = useState<Array<DiscogsCandidate>>([]);
	const [picked, setPicked] = useState<DiscogsCandidate | null>(null);
	const [query, setQuery] = useState({ artist: "", title: "" });
	const [context, setContext] = useState("");

	const analyze = useMutation({
		mutationFn: (vars: {
			imageBase64: string;
			mediaType: string;
			context: string;
		}) => analyzePhoto({ data: vars }),
		onSuccess: (s) => {
			setSuggestion(s);
			setCandidates(s.candidates);
			setPicked(null);
			setQuery({ artist: s.artist, title: s.title });
		},
	});

	const search = useMutation({
		mutationFn: (q: { artist: string; title: string }) =>
			searchDiscogs({ data: q }),
		onSuccess: setCandidates,
	});

	async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		if (!file) return;
		setSuggestion(null);
		setMediaType(file.type || "image/jpeg");
		setPreview(await readFile(file));
	}

	return (
		<div className="max-w-lg space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Capture a record</h1>
				<p className="text-sm text-muted-foreground">
					Photograph the cover — Claude reads it, Discogs and Pitchfork fill in
					the rest. Confirm before saving.
				</p>
			</div>

			<label className="block">
				<span className="sr-only">Take or choose a photo</span>
				<input
					type="file"
					accept="image/*"
					capture="environment"
					onChange={onFile}
					className="block w-full text-sm"
				/>
			</label>

			{preview && (
				<div className="space-y-3">
					<img
						src={preview}
						alt="Record cover preview"
						className="max-h-64 rounded-md border"
					/>
					{!suggestion && (
						<div className="space-y-1.5">
							<Label htmlFor="context">Additional context (optional)</Label>
							<Textarea
								id="context"
								value={context}
								onChange={(e) => setContext(e.target.value)}
								placeholder="e.g. it's a 2×LP reissue, or the deluxe pressing on red vinyl — anything that helps pin down the right Discogs release."
							/>
							<p className="text-xs text-muted-foreground">
								Helps Claude read the cover and search Discogs. Not saved with
								the record.
							</p>
						</div>
					)}
					{!suggestion && (
						<Button
							type="button"
							disabled={analyze.isPending}
							onClick={() =>
								analyze.mutate({ imageBase64: preview, mediaType, context })
							}
						>
							{analyze.isPending ? "Analyzing…" : "Analyze photo"}
						</Button>
					)}
					{analyze.isError && (
						<p className="text-sm text-destructive">
							Analysis failed. You can still add the record by hand from the New
							record page.
						</p>
					)}
				</div>
			)}

			{suggestion && (
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">
						Identified with {Math.round(suggestion.confidence * 100)}%
						confidence. Pick the right Discogs release if the match is off, then
						save.
					</p>

					{/* Manual Discogs search */}
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

					{/* Candidate pick-list */}
					{candidates.length > 0 && (
						<ul className="divide-y rounded-md border">
							{candidates.map((c) => {
								const active = picked?.discogsId === c.discogsId;
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
													className="size-10 rounded object-cover"
												/>
											) : (
												<div className="size-10 rounded bg-muted" />
											)}
											<span className="flex-1">
												<span className="font-medium">{c.artist}</span> —{" "}
												{c.title}
												{c.year ? ` (${c.year})` : ""}
												{c.label ? ` · ${c.label}` : ""}
											</span>
											{active && <span className="text-xs">✓</span>}
										</button>
									</li>
								);
							})}
						</ul>
					)}

					<RecordForm
						key={picked?.discogsId ?? "extracted"}
						defaultValues={toForm(suggestion, picked)}
						submitLabel="Save record"
						onSubmit={async (input) => {
							await createRecord({
								data: {
									...input,
									source: "photo",
									capturePhotoKey: suggestion.capturePhotoKey,
									discogsId: picked?.discogsId ?? suggestion.discogsId,
									discogsUrl: picked?.discogsUrl ?? suggestion.discogsUrl,
									pitchforkUrl: suggestion.pitchforkUrl,
								},
							});
							await queryClient.invalidateQueries({
								queryKey: recordsQueryOptions.queryKey,
							});
							navigate({ to: "/admin" });
						}}
					/>
				</div>
			)}
		</div>
	);
}
