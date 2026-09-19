SET time_zone = '+00:00';

-- A removal that a person asked for is a real delete: taking an image down on
-- the site, a removal by reaction, deleting the Discord message. For a short
-- time the bot archived those too; the owner decided they must not be kept.
-- Only the bot's own judgments stay archived, because they can be wrong and
-- must be reviewable: 'duplicate' (migration 003) and 'gone_from_discord' (the
-- sweep tool). The policy lives in node/src/util/imageRemoval.ts.
--
-- Both statements are no-ops on a re-run. Rows with the two remaining reasons
-- are not touched: the ENUM keeps their values and their positions.
DELETE FROM submissions_archive WHERE reason IN ('message_deleted', 'removed_by_reaction', 'removed_on_site');

-- In strict mode this fails, rather than blanking anything, if a row with one
-- of the removed values were somehow still there.
ALTER TABLE submissions_archive
    MODIFY COLUMN `reason` ENUM('duplicate','gone_from_discord') NOT NULL;
