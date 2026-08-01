import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckIcon,
	RefreshCwIcon,
	TrashIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import {
	createColor,
	DEFAULT_COLOR_NAME,
	deleteColor,
	regenerateColorTexture,
	uploadColorTexture,
} from "#/lib/colors";
import { colorsQueryOptions } from "#/lib/colors-queries";
import { cn } from "#/lib/utils";

/** Same read-to-data-URL helper used by the other upload flows (records.$id.tsx, capture.tsx). */
function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

interface ColorComboboxProps {
	/** Selected color id, as a string (form values are all strings) — "" = none. */
	value: string;
	onChange: (colorId: string) => void;
}

/**
 * Small round preview of a color chip's reference texture — the same image
 * `VinylDisc` tiles onto the disc itself. Falls back to a plain muted circle
 * while the texture is still generating (or failed/missing).
 */
function ColorSwatch({
	color,
	className,
}: {
	color: { textureImageKey?: string | null; textureStatus?: string | null };
	className?: string;
}) {
	const ready = color.textureStatus === "ready" && !!color.textureImageKey;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block shrink-0 rounded-full border bg-muted bg-cover bg-center",
				className,
			)}
			style={
				ready
					? { backgroundImage: `url(/api/photos/${color.textureImageKey})` }
					: undefined
			}
		/>
	);
}

/**
 * Vinyl color chip picker. Pick an existing chip or type a new name to create +
 * attach it in one step (upserted server-side, so re-typing an existing name
 * just attaches the same chip rather than duplicating it).
 */
export function ColorCombobox({ value, onChange }: ColorComboboxProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const queryClient = useQueryClient();
	const uploadInputRef = useRef<HTMLInputElement>(null);
	// Which color's upload button was clicked — one shared hidden file input
	// (only one file dialog can be open at a time anyway) needs to know where
	// the chosen file goes once `onChange` fires.
	const [uploadTargetId, setUploadTargetId] = useState<number | null>(null);

	const { data: colors = [] } = useQuery(colorsQueryOptions);
	const selected = colors.find((c) => c.id.toString() === value);

	const createMutation = useMutation({
		mutationFn: (name: string) => createColor({ data: { name } }),
		onSuccess: (color) => {
			if (!color) return;
			queryClient.invalidateQueries({ queryKey: colorsQueryOptions.queryKey });
			onChange(color.id.toString());
			setQuery("");
			setOpen(false);
		},
		onError: () => toast.error("Couldn't create the color."),
	});

	const regenerateMutation = useMutation({
		mutationFn: (colorId: number) =>
			regenerateColorTexture({ data: { colorId } }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: colorsQueryOptions.queryKey }),
		onError: () => toast.error("Couldn't regenerate the texture."),
	});

	const uploadMutation = useMutation({
		mutationFn: ({
			colorId,
			imageBase64,
		}: {
			colorId: number;
			imageBase64: string;
		}) => uploadColorTexture({ data: { colorId, imageBase64 } }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: colorsQueryOptions.queryKey }),
		onError: () => toast.error("Couldn't upload the texture."),
	});

	const handleUploadFile = async (file: File | undefined) => {
		if (!file || uploadTargetId == null) return;
		const colorId = uploadTargetId;
		setUploadTargetId(null);
		const imageBase64 = await readFileAsDataUrl(file);
		uploadMutation.mutate({ colorId, imageBase64 });
	};

	const deleteMutation = useMutation({
		mutationFn: (colorId: number) => deleteColor({ data: { colorId } }),
		onSuccess: (result, colorId) => {
			queryClient.invalidateQueries({ queryKey: colorsQueryOptions.queryKey });
			// The deleted color's records (including this field, if it was showing
			// the deleted color) were just reassigned to Black server-side — reflect
			// that here rather than leaving the field pointed at a gone colorId.
			if (result && colorId.toString() === value) {
				onChange(result.blackId.toString());
			}
		},
		onError: (err: Error) =>
			toast.error(err.message || "Couldn't delete the color."),
	});

	const handleDelete = (c: {
		id: number;
		name: string;
		recordCount: number;
	}) => {
		const usage =
			c.recordCount > 0
				? ` ${c.recordCount} record${c.recordCount === 1 ? "" : "s"} using it will be reset to "${DEFAULT_COLOR_NAME}".`
				: "";
		if (confirm(`Delete "${c.name}"?${usage}`)) {
			deleteMutation.mutate(c.id);
		}
	};

	const trimmedQuery = query.trim();
	const filtered = colors.filter((c) =>
		c.name.toLowerCase().includes(trimmedQuery.toLowerCase()),
	);
	const exactMatch = colors.some(
		(c) => c.name.toLowerCase() === trimmedQuery.toLowerCase(),
	);

	return (
		<div className="flex items-center gap-2">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="justify-start font-normal"
					>
						{selected ? (
							<span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
								<ColorSwatch color={selected} className="size-3" />
								{selected.name}
							</span>
						) : (
							<span className="text-muted-foreground">Select color…</span>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-64 space-y-2 p-2" align="start">
					<Input
						autoFocus
						placeholder="Search or add a color…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && trimmedQuery && !exactMatch) {
								e.preventDefault();
								createMutation.mutate(trimmedQuery);
							}
						}}
					/>
					<div className="max-h-48 space-y-1 overflow-y-auto">
						{filtered.map((c) => (
							<div
								key={c.id}
								className={cn(
									"group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent",
									c.id.toString() === value && "bg-accent",
								)}
							>
								<button
									type="button"
									onClick={() => {
										onChange(c.id.toString());
										setQuery("");
										setOpen(false);
									}}
									className="flex flex-1 items-center gap-1.5 text-left"
								>
									<span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
										<ColorSwatch color={c} className="size-3" />
										{c.name}
									</span>
									{c.textureStatus === "failed" && (
										<span className="text-xs text-destructive">
											texture failed
										</span>
									)}
								</button>
								<div className="flex items-center gap-1">
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										aria-label={`Upload ${c.name} texture`}
										className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
										disabled={uploadMutation.isPending}
										onClick={(e) => {
											e.stopPropagation();
											setUploadTargetId(c.id);
											uploadInputRef.current?.click();
										}}
									>
										<UploadIcon className="size-3.5" />
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										aria-label={`Regenerate ${c.name} texture`}
										className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
										disabled={
											regenerateMutation.isPending ||
											c.textureStatus === "queued" ||
											c.textureStatus === "processing"
										}
										onClick={(e) => {
											e.stopPropagation();
											regenerateMutation.mutate(c.id);
										}}
									>
										<RefreshCwIcon
											className={cn(
												"size-3.5",
												(c.textureStatus === "queued" ||
													c.textureStatus === "processing") &&
													"animate-spin",
											)}
										/>
									</Button>
									{c.name !== DEFAULT_COLOR_NAME && (
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											aria-label={`Delete ${c.name}`}
											className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
											disabled={deleteMutation.isPending}
											onClick={(e) => {
												e.stopPropagation();
												handleDelete(c);
											}}
										>
											<TrashIcon className="size-3.5" />
										</Button>
									)}
									{c.id.toString() === value && (
										<CheckIcon className="size-4 text-muted-foreground" />
									)}
								</div>
							</div>
						))}
						{filtered.length === 0 && !trimmedQuery && (
							<p className="px-2 py-1.5 text-sm text-muted-foreground">
								No colors yet.
							</p>
						)}
					</div>
					{trimmedQuery && !exactMatch && (
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="w-full justify-start"
							disabled={createMutation.isPending}
							onClick={() => createMutation.mutate(trimmedQuery)}
						>
							{createMutation.isPending
								? "Adding…"
								: `Create "${trimmedQuery}"`}
						</Button>
					)}
				</PopoverContent>
			</Popover>
			{selected && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label="Clear color"
					onClick={() => onChange("")}
				>
					<XIcon className="size-4" />
				</Button>
			)}
			<input
				ref={uploadInputRef}
				type="file"
				accept="image/*"
				className="hidden"
				onChange={(e) => {
					handleUploadFile(e.target.files?.[0]);
					e.target.value = "";
				}}
			/>
		</div>
	);
}
