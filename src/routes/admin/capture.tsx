import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Camera, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

import { ColorCombobox } from "#/components/color-combobox";
import { DuplicateBadge } from "#/components/duplicate-badge";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { uploadCapture } from "#/lib/capture-upload";
import { likelyDuplicateOf } from "#/lib/duplicates";
import { type ProcessedImage, squareDownscale } from "#/lib/image-resize";
import { recordQueryOptions, recordsQueryOptions } from "#/lib/records-queries";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/admin/capture")({ component: Capture });

/**
 * One row in the "this session" strip. Subscribes to the record so the badge
 * flips pending → analyzing → needs review on its own, and the artist/title
 * fill in as soon as the background analysis lands — no navigating away.
 */
function SessionItem({ id }: { id: number }) {
	const { data: record } = useQuery({
		...recordQueryOptions(id),
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "pending" || status === "processing" ? 2000 : false;
		},
	});
	// Live duplicate signal — same criteria as the list/detail badges: a same
	// master/release/name sibling in the current collection.
	const { data: allRecords } = useQuery(recordsQueryOptions);
	const duplicateId = record
		? likelyDuplicateOf(record, allRecords ?? [])
		: null;

	const key = record?.coverImageKey ?? record?.capturePhotoKey;
	// Until the analysis fills in a name, show a muted placeholder.
	const identified = Boolean(record?.artist || record?.title);
	const label = identified
		? `${record?.artist || "Unknown"} — ${record?.title || "Untitled"}`
		: "Capturing record";

	return (
		<li>
			<Link
				to="/admin/records/$id"
				params={{ id: String(id) }}
				className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50"
			>
				{key ? (
					<img
						src={`/api/photos/${key}`}
						alt=""
						className="size-10 shrink-0 rounded object-cover"
					/>
				) : (
					<div className="size-10 shrink-0 rounded bg-muted" />
				)}
				<span
					className={cn(
						"min-w-0 flex-1 truncate",
						!identified && "text-muted-foreground",
					)}
				>
					{label}
				</span>
				{record?.copyOf == null && duplicateId != null && (
					<DuplicateBadge className="shrink-0" />
				)}
				<StatusBadge
					status={record?.status ?? "pending"}
					className="shrink-0"
				/>
			</Link>
		</li>
	);
}

function readFile(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/**
 * Crop to a square and downscale in the browser for a fast upload, falling back
 * to the untouched file if the browser can't decode it (e.g. HEIC on desktop).
 */
async function prepareUpload(file: File): Promise<ProcessedImage> {
	try {
		return await squareDownscale(file);
	} catch {
		return {
			blob: file,
			dataUrl: await readFile(file),
			mediaType: file.type || "image/jpeg",
		};
	}
}

/** One-tap format hints appended to the context field. */
const CONTEXT_PRESETS = ["Single LP", "2×LP", '7"', '10"', '12"', "EP"];

/** Match a preset as a whole, comma-separated segment (case-insensitive). */
function hasPreset(context: string, preset: string): boolean {
	return context
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.includes(preset.toLowerCase());
}

/** Append the preset if absent, or strip it out if already present. */
function togglePreset(context: string, preset: string): string {
	if (hasPreset(context, preset)) {
		return context
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s && s.toLowerCase() !== preset.toLowerCase())
			.join(", ");
	}
	const trimmed = context.trim().replace(/,\s*$/, "");
	return trimmed ? `${trimmed}, ${preset}` : preset;
}

function Capture() {
	const queryClient = useQueryClient();

	const [photo, setPhoto] = useState<ProcessedImage | null>(null);
	const [context, setContext] = useState("");
	const [colorId, setColorId] = useState("");
	const [dragOver, setDragOver] = useState(false);
	const [reading, setReading] = useState(false);
	// Records captured in this sitting, newest first — lets you shoot a stack of
	// sleeves back-to-back and watch each get matched without leaving the page.
	const [session, setSession] = useState<Array<number>>([]);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const cameraInputRef = useRef<HTMLInputElement>(null);

	const capture = useMutation({
		mutationFn: (vars: {
			photo: ProcessedImage;
			context: string;
			colorId: string;
		}) =>
			uploadCapture({
				blob: vars.photo.blob,
				mediaType: vars.photo.mediaType,
				context: vars.context,
				colorId: vars.colorId,
			}),
		onSuccess: async (record) => {
			await queryClient.invalidateQueries({
				queryKey: recordsQueryOptions.queryKey,
			});
			// Stay put and reset for the next sleeve — the session strip below tracks
			// this capture as the AI works through it in the background.
			setSession((prev) => [record.id, ...prev]);
			reset();
		},
	});

	async function handleFile(file: File | undefined) {
		if (!file || !file.type.startsWith("image/")) return;
		// Decoding + cropping a large HEIC/JPEG isn't instant — show a spinner.
		setReading(true);
		try {
			setPhoto(await prepareUpload(file));
		} finally {
			setReading(false);
		}
	}

	function reset() {
		setPhoto(null);
		setContext("");
		setColorId("");
		capture.reset();
	}

	return (
		<div className="mx-auto w-full max-w-2xl space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Capture a record</h1>
				<p className="text-sm text-muted-foreground">
					Photograph the cover and save it — Claude reads it, Discogs and
					Pitchfork fill in the rest in the background. Keep shooting one sleeve
					after another; review and publish them later from the collection.
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
			) : !photo ? (
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
						capture.mutate({ photo, context, colorId });
					}}
				>
					<div className="space-y-2">
						<img
							src={photo.dataUrl}
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
						<div className="flex flex-wrap gap-1.5">
							{CONTEXT_PRESETS.map((preset) => {
								const active = hasPreset(context, preset);
								return (
									<Button
										key={preset}
										type="button"
										size="xs"
										variant="outline"
										className={cn(active && "bg-accent text-accent-foreground")}
										onClick={() => setContext((c) => togglePreset(c, preset))}
									>
										{preset}
									</Button>
								);
							})}
						</div>
						<p className="text-xs text-muted-foreground">
							Used to help Claude read the cover and search Discogs.
						</p>
					</div>

					<div className="space-y-1.5">
						<Label>Color (optional)</Label>
						<ColorCombobox value={colorId} onChange={setColorId} />
						<p className="text-xs text-muted-foreground">
							Leave unset to default to Black — you can change it later from the
							record's edit page.
						</p>
					</div>

					<Button type="submit" disabled={capture.isPending}>
						{capture.isPending ? (
							<>
								<Loader2 className="animate-spin" />
								Uploading…
							</>
						) : (
							"Capture record"
						)}
					</Button>

					{capture.isError && (
						<p className="text-sm text-destructive">
							Couldn’t save the capture. Try again, or add the record by hand
							from the{" "}
							<Link
								to="/admin/records/new"
								className="underline underline-offset-4"
							>
								New record page
							</Link>
							.
						</p>
					)}
				</form>
			)}

			{session.length > 0 && (
				<div className="space-y-2">
					<div className="flex items-center gap-2 text-sm font-medium">
						<CheckCircle2 className="size-4 text-green-600" />
						Captured this session ({session.length})
					</div>
					<ul className="divide-y rounded-md border">
						{session.map((id) => (
							<SessionItem key={id} id={id} />
						))}
					</ul>
					<Button asChild variant="outline" className="w-full">
						<Link to="/admin">Review &amp; publish in the collection</Link>
					</Button>
				</div>
			)}
		</div>
	);
}
