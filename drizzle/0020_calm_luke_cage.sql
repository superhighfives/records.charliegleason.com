CREATE TABLE `colors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `colors_name_unique` ON `colors` (`name`);--> statement-breakpoint
ALTER TABLE `records` ADD `color_id` integer REFERENCES colors(id);