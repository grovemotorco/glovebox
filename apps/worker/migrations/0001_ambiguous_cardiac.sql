CREATE TABLE `apiKeyMetadata` (
	`apiKeyId` text PRIMARY KEY NOT NULL,
	`principalId` text NOT NULL,
	`purpose` text NOT NULL,
	`scopesJson` text DEFAULT '[]' NOT NULL,
	`workspaceIdsJson` text DEFAULT '[]' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastUsedAt` integer,
	FOREIGN KEY (`apiKeyId`) REFERENCES `apikey`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`principalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_apiKeyMetadata_principalId` ON `apiKeyMetadata` (`principalId`);--> statement-breakpoint
CREATE INDEX `idx_apiKeyMetadata_purpose` ON `apiKeyMetadata` (`purpose`);--> statement-breakpoint
CREATE TABLE `principal` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`userId` text,
	`displayName` text NOT NULL,
	`email` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_principal_userId` ON `principal` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_principal_email` ON `principal` (`email`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`authEpoch` integer DEFAULT 0 NOT NULL,
	`deletedAt` integer,
	`createdByPrincipalId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`createdByPrincipalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_slug` ON `workspace` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_workspace_createdByPrincipalId` ON `workspace` (`createdByPrincipalId`);--> statement-breakpoint
CREATE TABLE `workspaceInvite` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`owner` integer DEFAULT false NOT NULL,
	`tokenHash` text NOT NULL,
	`status` text NOT NULL,
	`invitedByPrincipalId` text NOT NULL,
	`acceptedByPrincipalId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`acceptedAt` integer,
	FOREIGN KEY (`workspaceId`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invitedByPrincipalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`acceptedByPrincipalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspaceInvite_tokenHash` ON `workspaceInvite` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `idx_workspaceInvite_workspaceId` ON `workspaceInvite` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `idx_workspaceInvite_email` ON `workspaceInvite` (`email`);--> statement-breakpoint
CREATE TABLE `workspaceMember` (
	`workspaceId` text NOT NULL,
	`principalId` text NOT NULL,
	`role` text NOT NULL,
	`owner` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`workspaceId`, `principalId`),
	FOREIGN KEY (`workspaceId`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`principalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workspaceMember_principalId` ON `workspaceMember` (`principalId`);