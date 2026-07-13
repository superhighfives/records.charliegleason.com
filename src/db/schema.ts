import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A vinyl record in the collection.
 *
 * Core fields (artist/title/year/...) are populated by the AI photo flow and
 * enriched from Discogs + The Fork (Pitchfork). The cover photo lives in R2;
 * `coverImageKey` is the R2 object key, not the bytes.
 */
export const records = sqliteTable("records", {
	id: integer("id").primaryKey({ autoIncrement: true }),

	// Core metadata
	artist: text("artist").notNull(),
	title: text("title").notNull(),
	year: integer("year"),
	label: text("label"),
	// Record type — LP / EP / Single etc. (was always "LP"; now parsed from Discogs).
	format: text("format").default("LP"),
	// Physical size of the disc — e.g. '12"', '10"', '7"'. Parsed from Discogs.
	size: text("size"),
	genre: text("genre"),

	// Enrichment
	pitchforkScore: real("pitchfork_score"), // via the-fork.vercel.app
	pitchforkUrl: text("pitchfork_url"),
	discogsId: text("discogs_id"),
	discogsUrl: text("discogs_url"),
	catno: text("catno"), // Discogs catalog number, e.g. "WIGLP450"
	country: text("country"), // pressing country

	// Valuation (admin only — never exposed on the public homepage / API).
	// `confirmedRelease` marks a Discogs match the collector has vouched for (the
	// automated match isn't always right); the admin can sort/filter by it. The
	// "guessed" value comes from Discogs' seller price suggestions (VG+ grade,
	// stored in `discogsValue`, full per-condition breakdown in `discogsValueJson`);
	// `manualValue` is a hand-entered "confirmed" value that overrides the guess.
	confirmedRelease: integer("confirmed_release", { mode: "boolean" }).default(
		false,
	),
	manualValue: real("manual_value"), // hand-entered confirmed value, USD
	discogsValue: real("discogs_value"), // guessed value from Discogs, USD
	discogsValueCurrency: text("discogs_value_currency"), // currency of the guess, e.g. "USD"
	discogsValueJson: text("discogs_value_json"), // JSON per-condition price breakdown
	discogsValueFetchedAt: integer("discogs_value_fetched_at", {
		mode: "timestamp",
	}),

	// Storage / provenance
	coverImageKey: text("cover_image_key"), // R2 key — good cover, sourced + resized (public)
	capturePhotoKey: text("capture_photo_key"), // R2 key — the original iPhone shot (admin only)

	// Professional studio photo — a straight-on, cropped, evenly-toned square built
	// deterministically from the iPhone capture (no AI, no paid call):
	//   1. The sleeve's four corners are picked in the admin corner editor (auto-seeded by
	//      a lightweight sleeve-detection pass on capture) and stored as `sleeveCornersJson`
	//      — normalised [[x,y]×4] in TL,TR,BR,BL order. A fresh capture defaults to the
	//      full frame when detection can't find the sleeve.
	//   2. Those corners drive a perspective-warp + crop + auto-tone of the real capture
	//      pixels → the displayed `professionalImageKey` under `professional/`. Free (pure
	//      pixel math), so it re-runs whenever the admin nudges the corners or the
	//      `professionalParamsJson` tone/margin knobs.
	// `professionalStatus` tracks generation: `pending`/`processing` while the (queued)
	// reframe runs, `failed` on error. Reviewed before it goes live: `ready` = generated,
	// awaiting approval; `approved` = promoted and preferred over the Discogs cover for
	// display (see displayCoverKey). Best-effort in its own queue mode, so it never blocks
	// the main capture status machine.
	sleeveCornersJson: text("sleeve_corners_json"), // normalised sleeve corners (JSON), admin-picked
	professionalImageKey: text("professional_image_key"), // R2 key — pro photo (public once approved)
	professionalParamsJson: text("professional_params_json"), // last reframe knob settings (JSON)
	professionalStatus: text("professional_status", {
		enum: ["idle", "pending", "processing", "ready", "approved", "failed"],
	}).default("idle"),
	professionalError: text("professional_error"), // last generation error, surfaced in admin

	notes: text("notes"),
	source: text("source", { enum: ["photo", "manual", "import"] }).default(
		"manual",
	),

	// Background analysis (Cloudflare Queue). Photo captures land as `pending`,
	// the consumer flips them `processing` → `review` (awaiting confirmation) →
	// `complete` once published. `failed` means the AI work errored after retries.
	// Manual/import records skip the queue and are `complete` from the start.
	status: text("status", {
		enum: ["pending", "processing", "review", "failed", "complete"],
	}).default("complete"),
	error: text("error"), // last analysis error message, surfaced on the detail page
	confidence: real("confidence"), // 0–1 vision confidence from the last analysis
	captureContext: text("capture_context"), // optional collector hint, used by the analysis
	candidatesJson: text("candidates_json"), // JSON Array<DiscogsCandidate> the consumer found

	// Duplicate detection. After analysis identifies a record, the queue consumer
	// checks it against the rest of the collection; if it already owns the same
	// release this holds the id of the earlier record it duplicates (else null).
	duplicateOf: integer("duplicate_of"),

	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
	updatedAt: integer("updated_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export type Record = typeof records.$inferSelect;
export type NewRecord = typeof records.$inferInsert;
