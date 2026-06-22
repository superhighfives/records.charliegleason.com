import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { captureRecord } from "#/lib/records";
import { recordsQueryOptions } from "#/lib/records-queries";

export const Route = createFileRoute("/admin/capture")({ component: Capture });

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
	const [context, setContext] = useState("");

	const capture = useMutation({
		mutationFn: (vars: {
			imageBase64: string;
			mediaType: string;
			context: string;
		}) => captureRecord({ data: vars }),
		onSuccess: async (record) => {
			await queryClient.invalidateQueries({
				queryKey: recordsQueryOptions.queryKey,
			});
			// Jump to the detail page and watch the AI work land.
			navigate({ to: "/admin/records/$id", params: { id: String(record.id) } });
		},
	});

	async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		if (!file) return;
		setMediaType(file.type || "image/jpeg");
		setPreview(await readFile(file));
	}

	return (
		<div className="max-w-lg space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Capture a record</h1>
				<p className="text-sm text-muted-foreground">
					Photograph the cover and save it — Claude reads it, Discogs and
					Pitchfork fill in the rest in the background. You’ll confirm the
					details before it goes live.
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
				<div className="space-y-4">
					<img
						src={preview}
						alt="Record cover preview"
						className="max-h-64 rounded-md border"
					/>

					<div className="space-y-1.5">
						<Label htmlFor="context">Additional context (optional)</Label>
						<Textarea
							id="context"
							value={context}
							onChange={(e) => setContext(e.target.value)}
							placeholder="e.g. it's a 2×LP reissue, or the deluxe pressing on red vinyl — anything that helps pin down the right Discogs release."
						/>
						<p className="text-xs text-muted-foreground">
							Used to help Claude read the cover and search Discogs.
						</p>
					</div>

					<Button
						type="button"
						disabled={capture.isPending}
						onClick={() =>
							capture.mutate({ imageBase64: preview, mediaType, context })
						}
					>
						{capture.isPending ? "Saving…" : "Capture record"}
					</Button>

					{capture.isError && (
						<p className="text-sm text-destructive">
							Couldn’t save the capture. Try again, or add the record by hand
							from the New record page.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
