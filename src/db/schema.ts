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
	format: text("format").default("LP"),
	genre: text("genre"),

	// Enrichment
	pitchforkScore: real("pitchfork_score"), // via the-fork.vercel.app
	pitchforkUrl: text("pitchfork_url"),
	discogsId: text("discogs_id"),
	discogsUrl: text("discogs_url"),

	// Storage / provenance
	coverImageKey: text("cover_image_key"), // R2 object key (PHOTOS bucket)
	notes: text("notes"),
	source: text("source", { enum: ["photo", "manual", "import"] }).default(
		"manual",
	),

	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
	updatedAt: integer("updated_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

export type Record = typeof records.$inferSelect;
export type NewRecord = typeof records.$inferInsert;
