CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer DEFAULT (unixepoch()),
	`kind` text NOT NULL,
	`level` text NOT NULL,
	`record_id` integer,
	`message` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `records` ADD `discogs_value_queued_at` integer;