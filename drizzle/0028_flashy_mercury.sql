CREATE TABLE `matte_audit_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`running` integer DEFAULT false,
	`checked` integer DEFAULT 0,
	`suspects` integer DEFAULT 0,
	`started_at` integer,
	`updated_at` integer
);
