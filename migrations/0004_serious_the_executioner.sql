CREATE TABLE `account_deletions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL,
	`purge_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_acct_del_status" CHECK("account_deletions"."status" IN ('pending','purged'))
);
--> statement-breakpoint
CREATE INDEX `idx_acct_del_purge_at` ON `account_deletions` (`status`,`purge_at`);--> statement-breakpoint
CREATE TABLE `export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`r2_key` text,
	`error` text,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_export_status" CHECK("export_jobs"."status" IN ('pending','ready','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_export_user` ON `export_jobs` (`user_id`,`requested_at`);