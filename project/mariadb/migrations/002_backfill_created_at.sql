SET time_zone = '+00:00';

-- Rows that predate createdAt get it from the attachment snowflake in the URL
-- path /attachments/<channelId>/<attachmentId>/: the top 42 bits of a snowflake
-- are milliseconds since the Discord epoch (2015-01-01T00:00:00Z). With the
-- session time zone set to UTC above, FROM_UNIXTIME yields a UTC DATETIME.
-- Only rows with createdAt IS NULL are touched, so a re-run changes nothing.
-- Ids are limited to 19 digits so the cast cannot overflow BIGINT UNSIGNED.

UPDATE homies
SET channelId = COALESCE(channelId, SUBSTRING_INDEX(SUBSTRING_INDEX(url, '/', 5), '/', -1)),
    createdAt = FROM_UNIXTIME(((CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(url, '/', 6), '/', -1) AS UNSIGNED) >> 22) + 1420070400000) DIV 1000)
WHERE createdAt IS NULL
  AND url REGEXP '^https://(cdn[.]discordapp[.]com|media[.]discordapp[.]net)/attachments/[0-9]{15,19}/[0-9]{15,19}/';

UPDATE pets
SET channelId = COALESCE(channelId, SUBSTRING_INDEX(SUBSTRING_INDEX(url, '/', 5), '/', -1)),
    createdAt = FROM_UNIXTIME(((CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(url, '/', 6), '/', -1) AS UNSIGNED) >> 22) + 1420070400000) DIV 1000)
WHERE createdAt IS NULL
  AND url REGEXP '^https://(cdn[.]discordapp[.]com|media[.]discordapp[.]net)/attachments/[0-9]{15,19}/[0-9]{15,19}/';
