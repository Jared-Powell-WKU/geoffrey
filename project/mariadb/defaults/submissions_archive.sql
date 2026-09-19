-- Rows the bot removed from homies and pets on its own judgment (duplicates,
-- attachments gone from Discord), kept so they can be reviewed and restored.
-- Removals a person asked for are not kept. See migrations/003 and 004 and
-- node/src/util/imageRemoval.ts.
CREATE TABLE tncord.submissions_archive (
	`archiveId` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	`category` ENUM('homies','pets') NOT NULL,
	`id` BIGINT UNSIGNED NOT NULL,
	`url` VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`guildId` VARCHAR(50) NOT NULL,
	`userId` VARCHAR(50) DEFAULT NULL,
	`createdAt` DATETIME DEFAULT NULL,
	`source` ENUM('discord','web') NOT NULL DEFAULT 'discord',
	`channelId` VARCHAR(50) DEFAULT NULL,
	`messageId` VARCHAR(50) DEFAULT NULL,
	`reason` ENUM('duplicate','gone_from_discord') NOT NULL,
	`keptId` BIGINT UNSIGNED DEFAULT NULL,
	`archivedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (`archiveId`),
	UNIQUE KEY submissions_archive_row_UK (`category`, `id`)
)
ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_uca1400_ai_ci;
