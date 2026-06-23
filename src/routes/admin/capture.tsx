import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Camera, Loader2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
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
	const [dragOver, setDragOver] = useState(false);
	const [reading, setReading] = useState(false);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const cameraInputRef = useRef<HTMLInputElement>(null);

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

	async function handleFile(file: File | undefined) {
		if (!file || !file.type.startsWith("image/")) return;
		setMediaType(file.type || "image/jpeg");
		// Reading a large HEIC/JPEG to base64 isn't instant — show a spinner meanwhile.
		setReading(true);
		try {
			setPreview(await readFile(file));
		} finally {
			setReading(false);
		}
	}

	function reset() {
		setPreview(null);
		setContext("");
		capture.reset();
	}

	return (
		<div className="mx-auto max-w-2xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Capture a record</h1>
				<p className="text-sm text-muted-foreground">
					Photograph the cover and save it — Claude reads it, Discogs and
					Pitchfork fill in the rest in the background. You’ll confirm the
					details before it goes live.
				</p>
			</div>

			{/* Hidden inputs: one for the gallery/file picker, one that forces the camera. */}
			<input
				ref={fileInputRef}
				type="file"
				accept="image/*"
				className="hidden"
				onChange={(e) => handleFile(e.target.files?.[0])}
			/>
			<input
				ref={cameraInputRef}
				type="file"
				accept="image/*"
				capture="environment"
				className="hidden"
				onChange={(e) => handleFile(e.target.files?.[0])}
			/>

			{reading ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-muted-foreground/25 p-8 text-center">
					<div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
						<Loader2 className="size-6 animate-spin" />
					</div>
					<p className="font-medium">Loading photo…</p>
				</div>
			) : !preview ? (
				// biome-ignore lint/a11y/useSemanticElements: the dropzone wraps a nested "Open camera" button, so it can't itself be a <button>
				<div
					role="button"
					tabIndex={0}
					onClick={() => fileInputRef.current?.click()}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							fileInputRef.current?.click();
						}
					}}
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragOver(false);
						handleFile(e.dataTransfer.files?.[0]);
					}}
					className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
						dragOver
							? "border-primary bg-accent"
							: "border-muted-foreground/25 hover:border-primary/50 hover:bg-accent/40"
					}`}
				>
					<div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
						<UploadCloud className="size-6" />
					</div>
					<div className="space-y-0.5">
						<p className="font-medium text-primary">Tap to upload photo</p>
						<p className="text-xs text-muted-foreground">
							PNG, JPG or HEIC — or drag one in
						</p>
					</div>

					<div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
						<span className="h-px flex-1 bg-border" />
						OR
						<span className="h-px flex-1 bg-border" />
					</div>

					<Button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							cameraInputRef.current?.click();
						}}
					>
						<Camera />
						Open camera
					</Button>
				</div>
			) : (
				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (capture.isPending) return;
						capture.mutate({ imageBase64: preview, mediaType, context });
					}}
				>
					<div className="space-y-2">
						<img
							src={preview}
							alt="Record cover preview"
							className="max-h-64 rounded-md border"
						/>
						<button
							type="button"
							onClick={reset}
							className="text-sm text-muted-foreground underline underline-offset-4"
						>
							Choose a different photo
						</button>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="context">Additional context (optional)</Label>
						<Input
							id="context"
							value={context}
							onChange={(e) => setContext(e.target.value)}
							placeholder="e.g. 2×LP reissue, or deluxe red vinyl"
						/>
						<p className="text-xs text-muted-foreground">
							Used to help Claude read the cover and search Discogs.
						</p>
					</div>

					<Button type="submit" disabled={capture.isPending}>
						{capture.isPending ? "Saving…" : "Capture record"}
					</Button>

					{capture.isError && (
						<p className="text-sm text-destructive">
							Couldn’t save the capture. Try again, or add the record by hand
							from the New record page.
						</p>
					)}
				</form>
			)}
		</div>
	);
}
