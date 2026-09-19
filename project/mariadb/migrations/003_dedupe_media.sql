SET time_zone = '+00:00';

-- Removes second copies of the same Discord attachment (a channel-history
-- re-import in August 2025 stored ~3,500 attachments twice, under URLs that
-- differ only in their signature or host) and makes new ones impossible.
--
-- Nothing is hard-deleted: a row leaves homies or pets only after an exact copy
-- of it is in submissions_archive. Every statement is a no-op on a re-run.

-- 1. Where removed rows go. The bot archives here too (see util/imageRemoval.ts).
--    (category, id) is unique because ids are only unique per table.
CREATE TABLE IF NOT EXISTS submissions_archive (
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
    `reason` ENUM('duplicate','gone_from_discord','message_deleted','removed_by_reaction','removed_on_site') NOT NULL,
    `keptId` BIGINT UNSIGNED DEFAULT NULL,
    `archivedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`archiveId`),
    UNIQUE KEY submissions_archive_row_UK (`category`, `id`)
)
ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_uca1400_ai_ci;

-- 2. mediaKey is what a row is a picture OF. A Discord attachment is the same
--    picture whatever its signature (?ex=&is=&hm=), host (cdn.discordapp.com or
--    media.discordapp.net) or file name says, so its key is the channel and
--    attachment id from the path. Any other URL is its own key, query string
--    included, because elsewhere the query can select the image. The TypeScript
--    twin of this rule is mediaKey() in util/imageRemoval.ts.
--    messageId gets an index because message deletions look rows up by it.
ALTER TABLE homies
    ADD COLUMN IF NOT EXISTS `mediaKey` VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin AS (
        CASE WHEN `url` REGEXP '^https://(cdn[.]discordapp[.]com|media[.]discordapp[.]net)/attachments/[0-9]+/[0-9]+/'
             THEN CONCAT('discord:', SUBSTRING_INDEX(SUBSTRING_INDEX(`url`, '/', 6), '/', -2))
             ELSE `url` END
    ) PERSISTENT,
    ADD INDEX IF NOT EXISTS homies_message_IDX (`messageId`);

ALTER TABLE pets
    ADD COLUMN IF NOT EXISTS `mediaKey` VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin AS (
        CASE WHEN `url` REGEXP '^https://(cdn[.]discordapp[.]com|media[.]discordapp[.]net)/attachments/[0-9]+/[0-9]+/'
             THEN CONCAT('discord:', SUBSTRING_INDEX(SUBSTRING_INDEX(`url`, '/', 6), '/', -2))
             ELSE `url` END
    ) PERSISTENT,
    ADD INDEX IF NOT EXISTS pets_message_IDX (`messageId`);

-- 3. Per (guildId, mediaKey) keep one row: an owned row before an ownerless
--    one, then the later signature expiry (`ex`, hex seconds; unsigned counts
--    as 0), then the larger id. Production showed the later-signed copy to be
--    the accurate one: where the two copies name different owners it names the
--    real author, and an ownerless copy is always the unsigned original.
--    If an earlier run stopped between copying and removing, its copies are of
--    rows that are still live; they are dropped first so that this run decides
--    afresh and a row can never be both the survivor and archived.
DELETE a FROM submissions_archive a JOIN homies live ON a.category = 'homies' AND a.id = live.id WHERE a.reason = 'duplicate';
DELETE a FROM submissions_archive a JOIN pets live ON a.category = 'pets' AND a.id = live.id WHERE a.reason = 'duplicate';

--    Every other row is copied to the archive with the survivor's id...
INSERT IGNORE INTO submissions_archive (category, id, url, guildId, userId, createdAt, source, channelId, messageId, reason, keptId)
SELECT 'homies', id, url, guildId, userId, createdAt, source, channelId, messageId, 'duplicate', keptId
FROM (
    SELECT h.*,
        ROW_NUMBER() OVER w AS copyRank,
        FIRST_VALUE(h.id) OVER w AS keptId
    FROM (
        SELECT homies.*, IF(LOCATE('&ex=', REPLACE(url, '?', '&')) > 0,
            CAST(CONV(SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(url, '?', '&'), '&ex=', -1), '&', 1), 16, 10) AS UNSIGNED), 0) AS signedUntil
        FROM homies
    ) h
    WINDOW w AS (PARTITION BY h.guildId, h.mediaKey ORDER BY (h.userId IS NULL), h.signedUntil DESC, h.id DESC)
) ranked
WHERE copyRank > 1;

INSERT IGNORE INTO submissions_archive (category, id, url, guildId, userId, createdAt, source, channelId, messageId, reason, keptId)
SELECT 'pets', id, url, guildId, userId, createdAt, source, channelId, messageId, 'duplicate', keptId
FROM (
    SELECT p.*,
        ROW_NUMBER() OVER w AS copyRank,
        FIRST_VALUE(p.id) OVER w AS keptId
    FROM (
        SELECT pets.*, IF(LOCATE('&ex=', REPLACE(url, '?', '&')) > 0,
            CAST(CONV(SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(url, '?', '&'), '&ex=', -1), '&', 1), 16, 10) AS UNSIGNED), 0) AS signedUntil
        FROM pets
    ) p
    WINDOW w AS (PARTITION BY p.guildId, p.mediaKey ORDER BY (p.userId IS NULL), p.signedUntil DESC, p.id DESC)
) ranked
WHERE copyRank > 1;

--    ...and only then removed, by joining on the archive: a row that was not
--    archived as an exact copy, or whose survivor is not there, cannot match.
DELETE d FROM homies d
    JOIN submissions_archive a ON a.category = 'homies' AND a.id = d.id AND a.reason = 'duplicate' AND a.url = d.url AND a.guildId = d.guildId
    JOIN homies kept ON kept.id = a.keptId AND kept.id <> d.id AND kept.guildId = d.guildId AND kept.mediaKey = d.mediaKey;

DELETE d FROM pets d
    JOIN submissions_archive a ON a.category = 'pets' AND a.id = d.id AND a.reason = 'duplicate' AND a.url = d.url AND a.guildId = d.guildId
    JOIN pets kept ON kept.id = a.keptId AND kept.id <> d.id AND kept.guildId = d.guildId AND kept.mediaKey = d.mediaKey;

-- 4. From here on the database refuses a second copy. (guildId, mediaKey) is at
--    most 202 + 1026 bytes, inside InnoDB's 3072-byte key limit. The primary
--    key (url, guildId) stays.
ALTER TABLE homies ADD UNIQUE KEY IF NOT EXISTS homies_media_UK (`guildId`, `mediaKey`);
ALTER TABLE pets ADD UNIQUE KEY IF NOT EXISTS pets_media_UK (`guildId`, `mediaKey`);
