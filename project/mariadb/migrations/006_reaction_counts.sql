SET time_zone = '+00:00';

-- Reaction counts of the Discord message a row came from, for the site's
-- leaderboards (node/src/maintenance/reactionCounts.ts; contract in the
-- cantus.dev repo, docs/geoffrey-internal-api.md, "Reaction counts").
--
--   reactionCount      reactions on the message with any emoji, the bot's own excluded
--   flashCount         camera-flash reactions (the bot's own excluded)
--   reactionsCheckedAt when the bot last counted; NULL means "never counted"
--
-- NULL counts mean "not counted yet", not zero: the background job fills them
-- in over some hours after this ships, and the reaction events keep them
-- current from then on. Rows with no messageId never get counts.
--
-- Purely additive: three nullable columns that nothing has to write. The image
-- deployed before this migration names its columns in every INSERT and SELECT,
-- so it keeps working against the new shape, and a rollback of the image needs
-- no rollback of the schema. One ALTER per table so InnoDB applies it
-- atomically; every clause is a no-op when it has already been applied.

ALTER TABLE homies
    ADD COLUMN IF NOT EXISTS `reactionCount` INT UNSIGNED NULL,
    ADD COLUMN IF NOT EXISTS `flashCount` INT UNSIGNED NULL,
    ADD COLUMN IF NOT EXISTS `reactionsCheckedAt` DATETIME NULL;

ALTER TABLE pets
    ADD COLUMN IF NOT EXISTS `reactionCount` INT UNSIGNED NULL,
    ADD COLUMN IF NOT EXISTS `flashCount` INT UNSIGNED NULL,
    ADD COLUMN IF NOT EXISTS `reactionsCheckedAt` DATETIME NULL;
