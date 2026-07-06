ALTER TABLE `records` ADD `professional_image_key` text;--> statement-breakpoint
ALTER TABLE `records` ADD `professional_status` text DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE `records` ADD `professional_error` text;--> statement-breakpoint
ALTER TABLE `records` ADD `professional_prediction_id` text;