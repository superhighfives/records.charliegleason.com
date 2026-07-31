import { useForm } from "@tanstack/react-form";
import { useState } from "react";

import { ColorCombobox } from "#/components/color-combobox";
import { NotesContent } from "#/components/notes-content";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	formValuesToInput,
	type RecordFormValues,
	recordFormSchema,
} from "#/lib/record-schema";
import { cn } from "#/lib/utils.ts";

interface RecordFormProps {
	defaultValues: RecordFormValues;
	submitLabel: string;
	onSubmit: (values: ReturnType<typeof formValuesToInput>) => Promise<unknown>;
}

const TEXT_FIELDS = [
	{ name: "artist", label: "Artist", placeholder: "Aphex Twin" },
	{
		name: "title",
		label: "Title",
		placeholder: "Selected Ambient Works 85–92",
	},
	{ name: "year", label: "Year", placeholder: "1992" },
	{ name: "label", label: "Label", placeholder: "R&S Records" },
	{ name: "format", label: "Format", placeholder: "LP" },
	{ name: "size", label: "Size", placeholder: '12"' },
	{ name: "discCount", label: "Disc count", placeholder: "1" },
	{ name: "catno", label: "Catalog number", placeholder: "R&S 92016" },
	{ name: "country", label: "Country", placeholder: "UK" },
	{ name: "genre", label: "Genre", placeholder: "Electronic" },
	{ name: "pitchforkScore", label: "Pitchfork score", placeholder: "9.4" },
	{
		name: "manualValue",
		label: "Manual value (USD)",
		placeholder: "e.g. 45",
	},
] as const;

export function RecordForm({
	defaultValues,
	submitLabel,
	onSubmit,
}: RecordFormProps) {
	const [notesMode, setNotesMode] = useState<"edit" | "preview">("edit");

	const form = useForm({
		defaultValues,
		validators: { onChange: recordFormSchema },
		onSubmit: async ({ value }) => {
			await onSubmit(formValuesToInput(value));
		},
	});

	return (
		<form
			className="space-y-4"
			onSubmit={(e) => {
				e.preventDefault();
				form.handleSubmit();
			}}
		>
			{TEXT_FIELDS.map((f) => (
				<form.Field key={f.name} name={f.name}>
					{(field) => (
						<div className="space-y-1.5">
							<Label htmlFor={field.name}>{f.label}</Label>
							<Input
								id={field.name}
								name={field.name}
								placeholder={f.placeholder}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
							/>
							{field.state.meta.errors.length > 0 && (
								<p className="text-sm text-destructive">
									{field.state.meta.errors
										.map((err) =>
											typeof err === "string" ? err : err?.message,
										)
										.filter(Boolean)
										.join(", ")}
								</p>
							)}
						</div>
					)}
				</form.Field>
			))}

			<form.Field name="colorId">
				{(field) => (
					<div className="space-y-1.5">
						<Label htmlFor={field.name}>Color</Label>
						<ColorCombobox
							value={field.state.value}
							onChange={field.handleChange}
						/>
					</div>
				)}
			</form.Field>

			<form.Field name="notes">
				{(field) => (
					<div className="space-y-1.5">
						<div className="flex items-center justify-between">
							<Label htmlFor={field.name}>Notes</Label>
							<div className="flex items-center gap-3 text-[10px]">
								{(["edit", "preview"] as const).map((m) => (
									<button
										key={m}
										type="button"
										aria-pressed={notesMode === m}
										onClick={() => setNotesMode(m)}
										className={cn(
											"capitalize transition-colors",
											notesMode === m
												? "text-foreground underline underline-offset-4"
												: "text-muted-foreground/70 hover:text-foreground",
										)}
									>
										{m}
									</button>
								))}
							</div>
						</div>
						{notesMode === "preview" ? (
							<div className="min-h-48 rounded-md border border-input bg-secondary px-3 py-2">
								{field.state.value.trim() ? (
									<NotesContent>{field.state.value}</NotesContent>
								) : (
									<p className="text-sm text-muted-foreground">
										Nothing to preview yet.
									</p>
								)}
							</div>
						) : (
							<Textarea
								id={field.name}
								name={field.name}
								className="min-h-48"
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
							/>
						)}
						<p className="text-xs text-muted-foreground">
							Supports basic Markdown — **bold**, *italic*, [links](url) and
							lists.
						</p>
					</div>
				)}
			</form.Field>

			<form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
				{([canSubmit, isSubmitting]) => (
					<Button type="submit" disabled={!canSubmit}>
						{isSubmitting ? "Saving…" : submitLabel}
					</Button>
				)}
			</form.Subscribe>
		</form>
	);
}
