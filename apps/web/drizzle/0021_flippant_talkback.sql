ALTER TABLE `colors` ADD `texture_image_key` text;--> statement-breakpoint
ALTER TABLE `colors` ADD `texture_status` text DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE `colors` ADD `texture_error` text;--> statement-breakpoint
ALTER TABLE `records` ADD `disc_count` integer DEFAULT 1;