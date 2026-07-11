import { useForm } from "@tanstack/react-form";

import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	formValuesToInput,
	type RecordFormValues,
	recordFormSchema,
} from "#/lib/record-schema";

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

			<form.Field name="confirmedRelease">
				{(field) => (
					// `items-start` + the checkbox's top nudge keep the box aligned with the
					// first line when the label wraps on narrow screens. The Label is forced
					// back to `block` (its base is `flex`, which would split the heading and
					// the description into two columns that each wrap awkwardly on mobile) so
					// the text flows and wraps as one natural run instead.
					<div className="flex items-start gap-2">
						<Checkbox
							id={field.name}
							name={field.name}
							checked={field.state.value}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.checked)}
							className="mt-0.5"
						/>
						<Label htmlFor={field.name} className="block leading-snug">
							Confirmed release
							<span className="ml-1 font-normal text-muted-foreground">
								— this is the correct Discogs match
							</span>
						</Label>
					</div>
				)}
			</form.Field>

			<form.Field name="notes">
				{(field) => (
					<div className="space-y-1.5">
						<Label htmlFor={field.name}>Notes</Label>
						<Textarea
							id={field.name}
							name={field.name}
							value={field.state.value}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.value)}
						/>
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
