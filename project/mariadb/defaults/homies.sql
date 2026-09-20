CREATE TABLE tncord.homies (
	`url` varchar(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`guildId` varchar(50) NOT NULL,
	`userId` varchar(50) DEFAULT NULL,
	`id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
	`createdAt` datetime DEFAULT NULL,
	`source` enum('discord','web') NOT NULL DEFAULT 'discord',
	`channelId` varchar(50) DEFAULT NULL,
	`messageId` varchar(50) DEFAULT NULL,
	`mediaKey` varchar(1024) CHARACTER SET ascii COLLATE ascii_bin AS (
		CASE WHEN `url` REGEXP '^https://(cdn[.]discordapp[.]com|media[.]discordapp[.]net)/attachments/[0-9]+/[0-9]+/'
		     THEN CONCAT('discord:', SUBSTRING_INDEX(SUBSTRING_INDEX(`url`, '/', 6), '/', -2))
		     ELSE `url` END
	) PERSISTENT,
	`originCheckedAt` datetime DEFAULT NULL,
	`reactionCount` int(10) unsigned DEFAULT NULL,
	`flashCount` int(10) unsigned DEFAULT NULL,
	`reactionsCheckedAt` datetime DEFAULT NULL,
	CONSTRAINT homies_PK PRIMARY KEY (`url`,`guildId`),
	UNIQUE KEY homies_id_UK (`id`),
	UNIQUE KEY homies_media_UK (`guildId`,`mediaKey`),
	KEY homies_listing_IDX (`guildId`,`userId`,`createdAt`,`id`),
	KEY homies_message_IDX (`messageId`),
	KEY homies_pool_IDX (`guildId`,`createdAt`,`id`)
)
ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_uca1400_ai_ci;
