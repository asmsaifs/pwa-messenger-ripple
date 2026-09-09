ALTER TABLE `account` ADD `accessToken` text;--> statement-breakpoint
ALTER TABLE `account` ADD `refreshToken` text;--> statement-breakpoint
ALTER TABLE `account` ADD `idToken` text;--> statement-breakpoint
ALTER TABLE `account` ADD `accessTokenExpiresAt` integer;--> statement-breakpoint
ALTER TABLE `account` ADD `refreshTokenExpiresAt` integer;--> statement-breakpoint
ALTER TABLE `account` ADD `scope` text;--> statement-breakpoint
ALTER TABLE `verification` ADD `updatedAt` integer NOT NULL;