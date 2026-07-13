ALTER TABLE `records` ADD `sleeve_corners_json` text;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `cutout_image_key`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `professional_prediction_id`;