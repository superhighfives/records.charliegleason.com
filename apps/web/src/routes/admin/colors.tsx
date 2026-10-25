import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	AlertCircleIcon,
	PlusIcon,
	RefreshCwIcon,
	TrashIcon,
	UploadIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import { parseColorPalette } from "#/lib/color-palette";
import {
	createColor,
	DEFAULT_COLOR_NAME,
	deleteColor,
	type listColors,
	regenerateColorTexture,
	renameColor,
	setColorTranslucent,
	uploadColorTexture,
} from "#/lib/colors";
import { colorsQueryOptions } from "#/lib/colors-queries";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/admin/colors")({
	component: ColorsPage,
});

type ColorRow = Awaited<ReturnType<typeof listColors>>[number];

function isGenerating(status: string | null | undefined): boolean {
	return status === "queued" || status === "processing";
}

/** Same read-to-data-URL helper the other upload flows use (color-combobox.tsx). */
function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/**
 * Every vinyl colour in one place — the same chips the record form's combobox
 * offers, laid out with room to manage them: a disc preview of the texture
 * (with the shared clear-vinyl overlay, as the collection draws it), the
 * palette swatches behind the title gradient, how many records use it, and
 * rename / translucent / upload / regenerate / delete. Polls while any
 * texture is generating so the previews fill in by themselves.
 */
function ColorsPage() {
	const queryClient = useQueryClient();
	const { data: colors = [], isLoading } = useQuery({
		...colorsQueryOptions,
		refetchInterval: (query) =>
			query.state.data?.some((c) => isGenerating(c.textureStatus))
				? 3000
				: false,
	});
	const [query, setQuery] = useState("");
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: colorsQueryOptions.queryKey });

	const createMutation = useMutation({
		mutationFn: (name: string) => createColor({ data: { name } }),
		onSuccess: () => {
			setQuery("");
			invalidate();
		},
		onError: () => toast.error("Couldn't create the color."),
	});

	const trimmed = query.trim();
	const filtered = colors.filter((c) =>
		c.name.toLowerCase().includes(trimmed.toLowerCase()),
	);
	const exactMatch = colors.some(
		(c) => c.name.toLowerCase() === trimmed.toLowerCase(),
	);
	const totalRecords = colors.reduce((n, c) => n + c.recordCount, 0);

	return (
		<div className="mx-auto w-full max-w-2xl space-y-4">
			<header className="space-y-1">
				<h1 className="text-lg font-semibold">Colors</h1>
				<p className="text-sm text-muted-foreground">
					{colors.length} vinyl colors across {totalRecords} records. Each
					color's texture is shared by every record using it.
				</p>
			</header>

			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (trimmed && !exactMatch) createMutation.mutate(trimmed);
				}}
			>
				<Input
					placeholder="Search or add a color…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					aria-label="Search or add a color"
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={!trimmed || exactMatch || createMutation.isPending}
				>
					<PlusIcon />
					Add
				</Button>
			</form>

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : filtered.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					{trimmed
						? `No colors match “${trimmed}” — press Add to create it.`
						: "No colors yet."}
				</p>
			) : (
				<ul className="divide-y divide-border rounded-md border border-border">
					{filtered.map((c) => (
						<ColorItem key={c.id} color={c} onChanged={invalidate} />
					))}
				</ul>
			)}
		</div>
	);
}

function ColorItem({
	color: c,
	onChanged,
}: {
	color: ColorRow;
	onChanged: () => void;
}) {
	const uploadInputRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(c.name);
	const isDefault = c.name === DEFAULT_COLOR_NAME;
	const palette = parseColorPalette(c.palette);

	const renameMutation = useMutation({
		mutationFn: (next: string) =>
			renameColor({ data: { colorId: c.id, name: next } }),
		onSuccess: onChanged,
		onError: (err: Error) => {
			setName(c.name);
			toast.error(err.message || "Couldn't rename the color.");
		},
	});
	const translucentMutation = useMutation({
		mutationFn: (translucent: boolean) =>
			setColorTranslucent({ data: { colorId: c.id, translucent } }),
		onSuccess: onChanged,
		onError: () => toast.error("Couldn't update transparency."),
	});
	const regenerateMutation = useMutation({
		mutationFn: () => regenerateColorTexture({ data: { colorId: c.id } }),
		onSuccess: onChanged,
		onError: () => toast.error("Couldn't regenerate the texture."),
	});
	const uploadMutation = useMutation({
		mutationFn: (imageBase64: string) =>
			uploadColorTexture({ data: { colorId: c.id, imageBase64 } }),
		onSuccess: onChanged,
		onError: () => toast.error("Couldn't upload the texture."),
	});
	const deleteMutation = useMutation({
		mutationFn: () => deleteColor({ data: { colorId: c.id } }),
		onSuccess: onChanged,
		onError: (err: Error) =>
			toast.error(err.message || "Couldn't delete the color."),
	});

	const commitName = () => {
		const next = name.trim();
		if (!next || next === c.name) {
			setName(c.name);
			return;
		}
		renameMutation.mutate(next);
	};

	const handleDelete = () => {
		const usage =
			c.recordCount > 0
				? ` ${c.recordCount} record${c.recordCount === 1 ? "" : "s"} using it will be reset to "${DEFAULT_COLOR_NAME}".`
				: "";
		if (confirm(`Delete "${c.name}"?${usage}`)) deleteMutation.mutate();
	};

	const generating = isGenerating(c.textureStatus);

	return (
		<li className="flex flex-wrap items-center gap-4 px-3 py-3 sm:flex-nowrap">
			<DiscPreview color={c} />

			<div className="min-w-0 flex-1 space-y-1">
				<Input
					value={name}
					onChange={(e) => setName(e.target.value)}
					onBlur={commitName}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							setName(c.name);
							e.currentTarget.blur();
						}
					}}
					readOnly={isDefault}
					title={isDefault ? "The default color can't be renamed" : undefined}
					aria-label="Color name"
					className="h-8 border-transparent bg-transparent px-2 font-medium shadow-none hover:border-border focus-visible:border-border read-only:hover:border-transparent"
				/>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
					<span className="tabular-nums">
						{c.recordCount} record{c.recordCount === 1 ? "" : "s"}
					</span>
					<TextureStatus color={c} />
					{palette && (
						<span className="inline-flex items-center gap-1" title="Palette">
							{[palette.dominant, ...palette.colors].map((hex, i) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: palette entries can repeat
									key={i}
									className="size-3 rounded-full border border-border"
									style={{ backgroundColor: hex }}
								/>
							))}
						</span>
					)}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1">
				<label
					htmlFor={`translucent-${c.id}`}
					className="mr-2 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
				>
					<Switch
						id={`translucent-${c.id}`}
						size="sm"
						checked={c.translucent ?? false}
						disabled={translucentMutation.isPending}
						onCheckedChange={(v) => translucentMutation.mutate(v)}
					/>
					Translucent
				</label>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={`Upload ${c.name} texture`}
					title="Upload texture"
					disabled={uploadMutation.isPending}
					onClick={() => uploadInputRef.current?.click()}
				>
					<UploadIcon className="size-4" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={`Regenerate ${c.name} texture`}
					title="Regenerate texture"
					disabled={regenerateMutation.isPending || generating}
					onClick={() => regenerateMutation.mutate()}
				>
					<RefreshCwIcon
						className={cn("size-4", generating && "animate-spin")}
					/>
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={`Delete ${c.name}`}
					title={isDefault ? "The default color can't be deleted" : "Delete"}
					className="hover:text-destructive"
					disabled={isDefault || deleteMutation.isPending}
					onClick={handleDelete}
				>
					<TrashIcon className="size-4" />
				</Button>
				<input
					ref={uploadInputRef}
					type="file"
					accept="image/*"
					className="hidden"
					onChange={async (e) => {
						const file = e.target.files?.[0];
						e.target.value = "";
						if (file) uploadMutation.mutate(await readFileAsDataUrl(file));
					}}
				/>
			</div>
		</li>
	);
}

function TextureStatus({ color: c }: { color: ColorRow }) {
	switch (c.textureStatus) {
		case "ready":
			return null;
		case "queued":
			return <span>Texture queued…</span>;
		case "processing":
			return <span>Generating texture…</span>;
		case "failed":
			return (
				<span className="inline-flex items-center gap-1 text-destructive">
					<AlertCircleIcon className="size-3.5" />
					Texture failed{c.textureError ? ` — ${c.textureError}` : ""}
				</span>
			);
		default:
			return <span>No texture</span>;
	}
}

/**
 * A small disc drawn the way the collection draws one: the colour's texture
 * filling a circle, the shared clear-vinyl groove art over it, and the fill
 * dropped to the same opacity `VinylDisc` uses for translucent colours. Sits
 * on a checkerboard so translucency is visible here.
 */
function DiscPreview({ color: c }: { color: ColorRow }) {
	const ready = c.textureStatus === "ready" && !!c.textureImageKey;
	return (
		<div
			className="relative size-16 shrink-0 overflow-hidden rounded-full"
			style={{
				backgroundImage:
					"repeating-conic-gradient(var(--muted) 0 25%, var(--background) 0 50%)",
				backgroundSize: "12px 12px",
			}}
		>
			<div
				className={cn(
					"absolute inset-0 rounded-full bg-cover bg-center",
					!ready && "bg-foreground/70",
					isGenerating(c.textureStatus) && "animate-pulse",
				)}
				style={{
					backgroundImage: ready
						? `url(/api/photos/${c.textureImageKey})`
						: undefined,
					opacity: c.translucent ? 0.45 : 1,
				}}
			/>
			<img
				src="/vinyl/clear-12.png"
				alt=""
				className="absolute inset-0 size-full opacity-60"
			/>
		</div>
	);
}
