CREATE TABLE `records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artist` text NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`label` text,
	`format` text DEFAULT 'LP',
	`genre` text,
	`pitchfork_score` real,
	`pitchfork_url` text,
	`discogs_id` text,
	`discogs_url` text,
	`cover_image_key` text,
	`notes` text,
	`source` text DEFAULT 'manual',
	`created_at` integer DEFAULT (unixepoch()),
	`updated_at` integer DEFAULT (unixepoch())
);
