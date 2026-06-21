import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { RecordForm } from "#/components/record-form";
import { Button } from "#/components/ui/button";
import { analyzePhoto, type RecordSuggestion } from "#/lib/analyze";
import type { RecordFormValues } from "#/lib/record-schema";
import { createRecord } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/admin/capture")({ component: Capture });

function suggestionToForm(s: RecordSuggestion): RecordFormValues {
	return {
		artist: s.artist,
		title: s.title,
		year: s.year?.toString() ?? "",
		label: s.label ?? "",
		format: "LP",
		genre: s.genre ?? "",
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

	const analyze = useMutation({
		mutationFn: (vars: { imageBase64: string; mediaType: string }) =>
			analyzePhoto({ data: vars }),
		onSuccess: setSuggestion,
	});

	async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		if (!file) return;
		setSuggestion(null);
		setMediaType(file.type || "image/jpeg");
		const dataUrl = await readFile(file);
		setPreview(dataUrl);
	}

	return (
		<div className="max-w-lg space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Capture a record</h1>
				<p className="text-sm text-muted-foreground">
					Take a photo of the cover — Claude reads it, Discogs and Pitchfork
					fill in the rest. Confirm before saving.
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
						<Button
							type="button"
							disabled={analyze.isPending}
							onClick={() =>
								analyze.mutate({ imageBase64: preview, mediaType })
							}
						>
							{analyze.isPending ? "Analyzing…" : "Analyze photo"}
						</Button>
					)}
					{analyze.isError && (
						<p className="text-sm text-destructive">
							Analysis failed. You can still enter the record by hand from the
							New record page.
						</p>
					)}
				</div>
			)}

			{suggestion && (
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">
						Identified with {Math.round(suggestion.confidence * 100)}%
						confidence
						{suggestion.discogsUrl ? " · matched on Discogs" : ""}. Edit
						anything, then save.
					</p>
					<RecordForm
						defaultValues={suggestionToForm(suggestion)}
						submitLabel="Save record"
						onSubmit={async (input) => {
							await createRecord({
								data: {
									...input,
									source: "photo",
									coverImageKey: suggestion.coverImageKey,
									discogsId: suggestion.discogsId,
									discogsUrl: suggestion.discogsUrl,
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
