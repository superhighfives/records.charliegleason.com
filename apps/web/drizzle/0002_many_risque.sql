ALTER TABLE `records` ADD `status` text DEFAULT 'complete';--> statement-breakpoint
ALTER TABLE `records` ADD `error` text;--> statement-breakpoint
ALTER TABLE `records` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `records` ADD `capture_context` text;--> statement-breakpoint
ALTER TABLE `records` ADD `candidates_json` text;