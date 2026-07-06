ALTER TABLE `records` ADD `confirmed_release` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `records` ADD `manual_value` real;--> statement-breakpoint
ALTER TABLE `records` ADD `discogs_value` real;--> statement-breakpoint
ALTER TABLE `records` ADD `discogs_value_currency` text;--> statement-breakpoint
ALTER TABLE `records` ADD `discogs_value_json` text;--> statement-breakpoint
ALTER TABLE `records` ADD `discogs_value_fetched_at` integer;