CREATE TABLE `workspaceDocument` (
	`workspaceId` text NOT NULL,
	`fileId` text NOT NULL,
	`path` text NOT NULL,
	`contentKind` text NOT NULL,
	`sizeBytes` integer DEFAULT 0 NOT NULL,
	`currentVersionId` text,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`workspaceId`, `fileId`),
	FOREIGN KEY (`workspaceId`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workspaceDocument_workspaceId_path` ON `workspaceDocument` (`workspaceId`,`path`);--> statement-breakpoint
CREATE TABLE `documentVersion` (
	`workspaceId` text NOT NULL,
	`fileId` text NOT NULL,
	`versionId` text NOT NULL,
	`seq` integer NOT NULL,
	`contentVersionB64` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`createdByPrincipalId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`label` text,
	PRIMARY KEY(`workspaceId`, `fileId`, `versionId`),
	FOREIGN KEY (`createdByPrincipalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_documentVersion_fileId_createdAt` ON `documentVersion` (`workspaceId`,`fileId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `commentThread` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`fileId` text NOT NULL,
	`baseVersionId` text NOT NULL,
	`rangeStart` integer NOT NULL,
	`rangeEnd` integer NOT NULL,
	`rangeStale` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`body` text NOT NULL,
	`authorPrincipalId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`resolvedAt` integer,
	FOREIGN KEY (`authorPrincipalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_commentThread_workspace_file` ON `commentThread` (`workspaceId`,`fileId`);--> statement-breakpoint
CREATE INDEX `idx_commentThread_status` ON `commentThread` (`status`);--> statement-breakpoint
CREATE TABLE `suggestion` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`fileId` text NOT NULL,
	`baseVersionId` text NOT NULL,
	`rangeStart` integer NOT NULL,
	`rangeEnd` integer NOT NULL,
	`rangeStale` integer DEFAULT false NOT NULL,
	`replacementText` text NOT NULL,
	`status` text NOT NULL,
	`authorPrincipalId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`decidedByPrincipalId` text,
	`decidedAt` integer,
	FOREIGN KEY (`authorPrincipalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`decidedByPrincipalId`) REFERENCES `principal`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_suggestion_workspace_file` ON `suggestion` (`workspaceId`,`fileId`);--> statement-breakpoint
CREATE INDEX `idx_suggestion_status` ON `suggestion` (`status`);
