DROP TABLE `matte_audit_state`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `amazon_resolve_status`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `amazon_resolve_error`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `detection_confidence`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `detection_source`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `corners_reviewed`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `professional_enhanced`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `professional_alpha_key`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `professional_alpha_cutout_key`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `professional_alpha_source`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `professional_matte_audit_checked_at`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `professional_matte_audit_reason`;--> statement-breakpoint
ALTER TABLE `records` DROP COLUMN `professional_prediction_id`;