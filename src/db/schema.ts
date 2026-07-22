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
	// Discogs identity. `masterId` is the *master* (the album as a work) — the primary
	// Discogs identity, and the grain a record is grouped by. `discogsId` is an *optional*
	// specific release (pressing): when set, the record is "pinned" to that exact pressing
	// (which is what enables per-pressing valuation and the catno/country/size caches below);
	// when null, the record is album-level only. Both are nullable — a manual/unmatched
	// record may have neither.
	masterId: text("master_id"),
	masterUrl: text("master_url"),
	discogsId: text("discogs_id"),
	discogsUrl: text("discogs_url"),
	catno: text("catno"), // Discogs catalog number, e.g. "WIGLP450" — release-specific
	country: text("country"), // pressing country — release-specific

	// Valuation (admin only — never exposed on the public homepage / API).
	// The "guessed" value comes from Discogs' seller price suggestions (VG+ grade,
	// stored in `discogsValue`, full per-condition breakdown in `discogsValueJson`);
	// `manualValue` is a hand-entered "confirmed" value that overrides the guess.
	manualValue: real("manual_value"), // hand-entered confirmed value, USD
	discogsValue: real("discogs_value"), // guessed value from Discogs, USD
	discogsValueCurrency: text("discogs_value_currency"), // currency of the guess, e.g. "USD"
	discogsValueJson: text("discogs_value_json"), // JSON per-condition price breakdown
	discogsValueFetchedAt: integer("discogs_value_fetched_at", {
		mode: "timestamp",
	}),

	// Storage / provenance
	coverImageKey: text("cover_image_key"), // R2 key — good cover, sourced + resized (public)
	// Whether `coverImageKey` came from a manual upload (true) vs Discogs-sourced
	// artwork (false/default). Both live under `covers/`, so this is the only way to
	// tell them apart — used by the admin "Using upload" filter.
	coverIsUpload: integer("cover_is_upload", { mode: "boolean" }).default(false),
	capturePhotoKey: text("capture_photo_key"), // R2 key — the original iPhone shot (admin only)

	// Professional studio photo — a straight-on, cropped, evenly-toned square built
	// deterministically from the iPhone capture (no AI, no paid call):
	//   1. The sleeve's four corners are picked in the admin corner editor (auto-seeded by
	//      a lightweight sleeve-detection pass on capture) and stored as `sleeveCornersJson`
	//      — normalised [[x,y]×4] in TL,TR,BR,BL order. A fresh capture defaults to the
	//      full frame when detection can't find the sleeve.
	//   2. Those corners drive a perspective-warp + crop + auto-tone of the real capture
	//      pixels → the displayed `professionalImageKey` under `professional/`. Free (pure
	//      pixel math), so it runs synchronously — a first pass inline on capture, and again
	//      whenever the admin nudges the corners or the `professionalParamsJson` tone/polish
	//      knobs. There is no queue and no async job to wait on.
	// `professionalStatus` is the *display/approval* state of the current image (separate
	// from whether a generation job is running — that's `professionalJobStatus` below):
	// `idle` = nothing generated yet; `ready` = a photo exists but isn't shown on the site
	// (awaiting approval); `approved` = promoted and preferred over the Discogs cover for
	// display (see displayCoverKey); `failed` = generation errored. `pending`/`processing`
	// are kept in the enum only for historical rows. Crucially this is NOT downgraded while
	// a re-generation runs, so an approved cover stays live until the new one swaps in.
	sleeveCornersJson: text("sleeve_corners_json"), // normalised sleeve corners (JSON), admin-picked
	professionalImageKey: text("professional_image_key"), // R2 key — pro photo (public once approved)
	professionalParamsJson: text("professional_params_json"), // last reframe knob settings (JSON)
	professionalStatus: text("professional_status", {
		enum: ["idle", "pending", "processing", "ready", "approved", "failed"],
	}).default("idle"),
	// The background-job lifecycle for the (queued) Apply pipeline — reframe + Real-ESRGAN
	// enhance + AI matte, run in the queue consumer. `idle` = nothing running; `queued` =
	// enqueued, awaiting the consumer; `processing` = the consumer is running it; `failed`
	// = it errored after retries. Powers the header "in flight" menu and the editor's
	// generating state, independently of the display `professionalStatus` above.
	professionalJobStatus: text("professional_job_status", {
		enum: ["idle", "queued", "processing", "failed"],
	}).default("idle"),
	// Which stage of the two-step Apply pipeline is currently running, so the header
	// "in flight" menu can show progress as "(1/2)" (cover: reframe + enhance) →
	// "(2/2)" (matte + commit). Set by the consumer as each stage starts and cleared
	// on commit; `professionalJobStatus` stays `processing` across both. Null on legacy
	// rows and whenever no job is running (the menu falls back to the plain label).
	professionalStage: text("professional_stage", {
		enum: ["cover", "matte"],
	}),
	// A finer-grained, DISPLAY-ONLY sub-step within whichever pipeline is running, so the
	// header "in flight" menu can show real progress ("(2/4) Enhancing", "(1/4) Reading
	// cover") rather than just the coarse `professionalStage`. Shared across both pipelines —
	// a record is only ever in one at a time. Written by the consumer as each sub-step begins
	// and cleared to null on every terminal state (so a finished/failed row shows no stale
	// step); NOT load-bearing — nothing but the menu label reads it, so the reaper and editor
	// stay keyed on `professionalStage`/`status`. Null on legacy rows and between jobs.
	//   analyze: reading → matching (→ web-search) → scoring → artwork
	//   apply:   reframe → enhance → matte-ai | matte-fallback → finishing
	jobStep: text("job_step", {
		enum: [
			"reading",
			"matching",
			"web-search",
			"scoring",
			"artwork",
			"reframe",
			"enhance",
			"matte-ai",
			"matte-fallback",
			"finishing",
		],
	}),
	// Whether `professionalImageKey` is a Real-ESRGAN-upscaled master vs a plain reframe
	// of the capture. Reset to false whenever the photo is regenerated from the capture;
	// Apply now always enhances (a failed enhance fails the job rather than degrading), so
	// on a committed Apply this is true — it's false only for a fresh reframe pre-Apply.
	professionalEnhanced: integer("professional_enhanced", {
		mode: "boolean",
	}).default(false),
	professionalError: text("professional_error"), // last generation error, surfaced in admin
	// The "alpha matte": a second render — a transparent, true-edged sleeve floating on
	// a margin with a soft contact shadow — generated alongside the square from the same
	// corners on Apply. `professionalAlphaKey` is the shadow variant (used on the homepage
	// grid; public once the square is `approved`); `…CutoutKey` is the shadowless pure
	// cutout for compositing onto any background. `professionalAlphaSource` records whether
	// a matting model (`ai`) or the free deterministic edge-snap (`deterministic`) cut it
	// out. Both are stored under `alpha/` and cleared/rebuilt in lockstep with the square.
	professionalAlphaKey: text("professional_alpha_key"),
	professionalAlphaCutoutKey: text("professional_alpha_cutout_key"),
	professionalAlphaSource: text("professional_alpha_source", {
		enum: ["ai", "deterministic"],
	}),
	// Vestigial — the pipeline no longer makes any Replicate call. Kept as a nullable
	// column (not dropped) so a migration never has to remove something the currently
	// deployed production code still selects; a later migration can drop it post-merge.
	professionalPredictionId: text("professional_prediction_id"),
	// Bounded auto-retry budgets for the self-heal reaper (see listInFlight): when a
	// background job is found dead ("worker terminated mid-job" — an uncatchable OOM /
	// eviction the queue's own retries can't recover), the reaper re-enqueues a FRESH job
	// (clean isolate) up to MAX_AUTO_RETRIES times before flagging it terminally failed for
	// manual action, rather than failing on the first interruption. Counts fresh re-enqueues
	// only (the queue's per-message `attempts` retries are separate); reset to 0 on success
	// and on any manual re-trigger (Apply / Reprocess / Replace capture / Retry AI matte).
	analyzeRetryCount: integer("analyze_retry_count").default(0),
	professionalRetryCount: integer("professional_retry_count").default(0),

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

/** A fine-grained display-only sub-step of a running pipeline (see `records.jobStep`). */
export type JobStep = NonNullable<Record["jobStep"]>;
