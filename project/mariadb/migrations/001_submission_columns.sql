SET time_zone = '+00:00';

-- Gives homies and pets a stable row id, a creation time and the origin of
-- each row. One ALTER per table so InnoDB applies it atomically; every clause
-- is a no-op when it has already been applied.
--
-- url becomes ascii_bin so that 1024 characters plus guildId still fit in the
-- 3072-byte InnoDB key limit of the (url, guildId) primary key. The primary key
-- stays: the bot inserts and deletes by it. An AUTO_INCREMENT column has to be
-- added together with its key, so both are in the same statement.

ALTER TABLE homies
    MODIFY COLUMN `url` VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ADD COLUMN IF NOT EXISTS `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ADD COLUMN IF NOT EXISTS `createdAt` DATETIME NULL,
    ADD COLUMN IF NOT EXISTS `source` ENUM('discord','web') NOT NULL DEFAULT 'discord',
    ADD COLUMN IF NOT EXISTS `channelId` VARCHAR(50) NULL,
    ADD COLUMN IF NOT EXISTS `messageId` VARCHAR(50) NULL,
    ADD UNIQUE KEY IF NOT EXISTS homies_id_UK (`id`),
    ADD INDEX IF NOT EXISTS homies_listing_IDX (`guildId`, `userId`, `createdAt`, `id`);

ALTER TABLE pets
    MODIFY COLUMN `url` VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ADD COLUMN IF NOT EXISTS `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ADD COLUMN IF NOT EXISTS `createdAt` DATETIME NULL,
    ADD COLUMN IF NOT EXISTS `source` ENUM('discord','web') NOT NULL DEFAULT 'discord',
    ADD COLUMN IF NOT EXISTS `channelId` VARCHAR(50) NULL,
    ADD COLUMN IF NOT EXISTS `messageId` VARCHAR(50) NULL,
    ADD UNIQUE KEY IF NOT EXISTS pets_id_UK (`id`),
    ADD INDEX IF NOT EXISTS pets_listing_IDX (`guildId`, `userId`, `createdAt`, `id`);
