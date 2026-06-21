import { z } from "zod";

import type { Record } from "#/db/schema";

/**
 * Canonical, validated record input (numbers are numbers, optionals are null).
 * Server functions parse against this before touching D1.
 */
export const recordInputSchema = z.object({
	artist: z.string().trim().min(1, "Artist is required"),
	title: z.string().trim().min(1, "Title is required"),
	year: z.number().int().min(1860).max(2100).nullable(),
	label: z.string().trim().min(1).nullable(),
	format: z.string().trim().min(1),
	genre: z.string().trim().min(1).nullable(),
	pitchforkScore: z.number().min(0).max(10).nullable(),
	notes: z.string().trim().min(1).nullable(),
});

export type RecordInput = z.infer<typeof recordInputSchema>;

/**
 * Form state. The form deals in strings (text inputs); we convert to a
 * `RecordInput` on submit and let the server schema do the real validation.
 */
export type RecordFormValues = {
	artist: string;
	title: string;
	year: string;
	label: string;
	format: string;
	genre: string;
	pitchforkScore: string;
	notes: string;
};

const numericString = z
	.string()
	.refine(
		(s) => s.trim() === "" || !Number.isNaN(Number(s)),
		"Must be a number",
	);

/** Lightweight client-side validation (required fields + numeric formats). */
export const recordFormSchema = z.object({
	artist: z.string().min(1, "Artist is required"),
	title: z.string().min(1, "Title is required"),
	year: numericString,
	label: z.string(),
	format: z.string(),
	genre: z.string(),
	pitchforkScore: numericString,
	notes: z.string(),
});

export const emptyRecordForm: RecordFormValues = {
	artist: "",
	title: "",
	year: "",
	label: "",
	format: "LP",
	genre: "",
	pitchforkScore: "",
	notes: "",
};

const optional = (s: string) => {
	const t = s.trim();
	return t === "" ? null : t;
};

const optionalNumber = (s: string) => {
	const t = s.trim();
	return t === "" ? null : Number(t);
};

export function formValuesToInput(v: RecordFormValues): RecordInput {
	return {
		artist: v.artist.trim(),
		title: v.title.trim(),
		year: optionalNumber(v.year),
		label: optional(v.label),
		format: v.format.trim() || "LP",
		genre: optional(v.genre),
		pitchforkScore: optionalNumber(v.pitchforkScore),
		notes: optional(v.notes),
	};
}

export function recordToFormValues(r: Record): RecordFormValues {
	return {
		artist: r.artist,
		title: r.title,
		year: r.year?.toString() ?? "",
		label: r.label ?? "",
		format: r.format ?? "LP",
		genre: r.genre ?? "",
		pitchforkScore: r.pitchforkScore?.toString() ?? "",
		notes: r.notes ?? "",
	};
}
