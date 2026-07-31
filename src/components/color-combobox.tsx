import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { createColor } from "#/lib/colors";
import { colorsQueryOptions } from "#/lib/colors-queries";
import { cn } from "#/lib/utils";

interface ColorComboboxProps {
	/** Selected color id, as a string (form values are all strings) — "" = none. */
	value: string;
	onChange: (colorId: string) => void;
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
							<span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium">
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
							<button
								key={c.id}
								type="button"
								onClick={() => {
									onChange(c.id.toString());
									setQuery("");
									setOpen(false);
								}}
								className={cn(
									"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent",
									c.id.toString() === value && "bg-accent",
								)}
							>
								<span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium">
									{c.name}
								</span>
								{c.id.toString() === value && (
									<CheckIcon className="size-4 text-muted-foreground" />
								)}
							</button>
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
		</div>
	);
}
