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
	size: z.string().trim().min(1).nullable(),
	catno: z.string().trim().min(1).nullable(),
	country: z.string().trim().min(1).nullable(),
	genre: z.string().trim().min(1).nullable(),
	pitchforkScore: z.number().min(0).max(10).nullable(),
	notes: z.string().trim().min(1).nullable(),
});

export type RecordInput = z.infer<typeof recordInputSchema>;

/**
 * Create-time schema: the editable fields plus AI/enrichment fields the photo
 * flow carries through (Discogs ids, Pitchfork url, R2 key, provenance). Kept
 * separate from `recordInputSchema` so the edit form — which only knows the
 * editable fields — can't null these out on update.
 */
export const recordCreateSchema = recordInputSchema.extend({
	discogsId: z.string().nullish(),
	discogsUrl: z.string().nullish(),
	pitchforkUrl: z.string().nullish(),
	coverImageKey: z.string().nullish(),
	capturePhotoKey: z.string().nullish(),
	source: z.enum(["photo", "manual", "import"]).optional(),
});

export type RecordCreateInput = z.infer<typeof recordCreateSchema>;

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
	size: string;
	catno: string;
	country: string;
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
	size: z.string(),
	catno: z.string(),
	country: z.string(),
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
	size: "",
	catno: "",
	country: "",
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
		size: optional(v.size),
		catno: optional(v.catno),
		country: optional(v.country),
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
		size: r.size ?? "",
		catno: r.catno ?? "",
		country: r.country ?? "",
		genre: r.genre ?? "",
		pitchforkScore: r.pitchforkScore?.toString() ?? "",
		notes: r.notes ?? "",
	};
}
