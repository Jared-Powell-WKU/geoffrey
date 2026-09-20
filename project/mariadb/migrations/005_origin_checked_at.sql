SET time_zone = '+00:00';

-- 1. originCheckedAt: when the bot looked for the Discord message a row came
--    from (node/src/maintenance/backfillOrigins.ts). Rows from before channelId
--    and messageId existed are searched once; NULL means "not searched yet".
--    To search again: UPDATE homies SET originCheckedAt = NULL WHERE messageId IS NULL.
--
-- 2. The pool index. The site's pool lists every row of a guild, newest first
--    (WHERE guildId = ? ORDER BY createdAt DESC, id DESC). The listing index
--    (guildId, userId, createdAt, id) cannot give that order without a userId,
--    so every page sorted the whole guild, about 6,400 rows, before returning
--    48. This index is the same one without userId.
--
-- Purely additive: a nullable column that nothing has to write and an index.
-- The image that was deployed before this migration names its columns in every
-- INSERT and SELECT, so it keeps working against the new shape, and a rollback
-- of the image needs no rollback of the schema. One ALTER per table so InnoDB
-- applies it atomically; every clause is a no-op when it has already been applied.

ALTER TABLE homies
    ADD COLUMN IF NOT EXISTS `originCheckedAt` DATETIME NULL,
    ADD INDEX IF NOT EXISTS homies_pool_IDX (`guildId`, `createdAt`, `id`);

ALTER TABLE pets
    ADD COLUMN IF NOT EXISTS `originCheckedAt` DATETIME NULL,
    ADD INDEX IF NOT EXISTS pets_pool_IDX (`guildId`, `createdAt`, `id`);
