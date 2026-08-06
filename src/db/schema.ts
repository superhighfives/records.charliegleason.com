import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A reusable vinyl color chip (e.g. "Black", "Clear", "Red/Blue Splatter"),
 * picked/created from the admin color combobox. `name` is the display value
 * and the dedup key — the combobox upserts on it so re-typing an existing
 * color attaches the same chip rather than minting a duplicate.
 */
export const colors = sqliteTable("colors", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull().unique(),
	// AI-generated reference texture for this color's vinyl surface (a flat swatch,
	// not a full disc render — VinylDisc composites it with procedural grooves/hole).
	// Generated once per color name via the "color-texture" queue job, cached in R2
	// under `textures/` and reused by every record with this colorId.
	textureImageKey: text("texture_image_key"),
	textureStatus: text("texture_status", {
		enum: ["idle", "queued", "processing", "ready", "failed"],
	}).default("idle"),
	textureError: text("texture_error"),
	// Small palette sampled from the texture at generation time (JSON:
	// { dominant, colors[] } — see color-palette.ts). Drives the album title's
	// on-hover gradient in the collection grid. Best-effort: null on failed
	// extraction or legacy rows awaiting backfill (the title just stays untinted).
	palette: text("palette"),
	// Translucent vinyl (e.g. "Transparent Red", "Clear"): VinylDisc renders the
	// disc semi-transparent so the page background shows through, matching how the
	// physical record looks. Purely a render hint — the generated texture itself is
	// still an opaque swatch.
	translucent: integer("translucent", { mode: "boolean" }).default(false),
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export type Color = typeof colors.$inferSelect;
export type NewColor = typeof colors.$inferInsert;

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
	// Number of discs in this release (e.g. a 2xLP). Parsed from Discogs' per-format
	// `qty` (see parseDiscCount in discogs-shared.ts); manually editable, defaults to 1.
	discCount: integer("disc_count").default(1),
	genre: text("genre"),
	// Vinyl color chip — see `colors` above. Manual-only (Discogs enrichment
	// never touches this), so it's never nulled by a refresh/re-match.
	colorId: integer("color_id").references(() => colors.id),

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
	// Link health, maintained by the scheduled link-check job
	// (src/lib/master-health.ts). Discogs deletes/merges masters *and* releases over
	// time, so an id that once resolved can start 404ing — the `*Missing` flags mark
	// exactly that (a *broken* link, distinct from the never-assigned "unmatched"
	// case), and a record with no live link left is surfaced in the admin's red "fix
	// these" banner. The `*CheckedAt` timestamps are the last time the job validated
	// each link, so it re-checks the stalest first. Release health matters because a
	// record can be identity'd by a release alone (see `discogsId` below).
	masterMissing: integer("master_missing", { mode: "boolean" }).default(false),
	masterCheckedAt: integer("master_checked_at", { mode: "timestamp" }),
	discogsId: text("discogs_id"),
	discogsUrl: text("discogs_url"),
	releaseMissing: integer("release_missing", { mode: "boolean" }).default(
		false,
	),
	releaseCheckedAt: integer("release_checked_at", { mode: "timestamp" }),
	catno: text("catno"), // Discogs catalog number, e.g. "WIGLP450" — release-specific
	country: text("country"), // pressing country — release-specific

	// The background-job lifecycle for an Amazon ASIN→pressing resolution (the
	// importer's "Queue lookups" — see enqueueResolveAsinBatch/resolveAsinForRecord in
	// queue.ts): `idle` = nothing queued (or a prior job finished); `queued` = enqueued,
	// awaiting the consumer. There's no `processing` state — a single message either
	// pins a release or gives up, both fast, so `queued` alone covers "in flight" for
	// the header's queue menu. `failed` means it ran and couldn't pin a pressing
	// (no barcode, no matching release, or a master conflict) — best-effort and NOT
	// auto-retried, so `amazonResolveError` explains why and the importer's matching
	// filter still excludes it from being re-offered as a fresh "unmatched" purchase.
	amazonResolveStatus: text("amazon_resolve_status", {
		enum: ["idle", "queued", "failed"],
	}).default("idle"),
	amazonResolveError: text("amazon_resolve_error"),

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
	// enhance + Magic matte, run in the queue consumer. `idle` = nothing running; `queued` =
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
	// The on-demand admin "Audit covers" sweep (src/lib/matte-audit.ts): a cheap,
	// non-AI pixel scan of the stored `professionalAlphaCutoutKey` webp that flags
	// likely-bad renders (a colour cast invented on a dark cover, or the matte's alpha
	// bleeding into the transparent shadow margin) — both regression classes the matte
	// pipeline has quietly produced in the past. `CheckedAt` null = never audited (or
	// invalidated by a fresh matte, see professional-pipeline.ts); the sweep validates
	// stalest-first, same pattern as the Discogs link-health check. `Reason` is a
	// comma-joined list of what tripped ("tint", "edge", "tint,edge") or null when the
	// last check came back clean.
	professionalMatteAuditCheckedAt: integer(
		"professional_matte_audit_checked_at",
		{
			mode: "timestamp",
		},
	),
	professionalMatteAuditReason: text("professional_matte_audit_reason"),
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
	// and on any manual re-trigger (Apply / Reprocess / Replace capture / Retry Magic matte).
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

	// Intentional multiple copies — records the collector *knowingly* owns two (or
	// more) physical copies of. Set manually in admin: on a secondary copy this holds
	// the id of the PRIMARY record it's a copy of; a primary/standalone record is null.
	// Secondaries are hidden from the public collection and instead bump the primary's
	// "copies" count. One level deep only — a primary never itself has `copyOf` set.
	// Cleared as a back-reference on delete, promoting orphaned copies back to standalone.
	copyOf: integer("copy_of"),

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
