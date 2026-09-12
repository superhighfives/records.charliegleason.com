ALTER TABLE `records` ADD `detection_confidence` real;--> statement-breakpoint
ALTER TABLE `records` ADD `detection_source` text;--> statement-breakpoint
ALTER TABLE `records` ADD `corners_reviewed` integer DEFAULT false;