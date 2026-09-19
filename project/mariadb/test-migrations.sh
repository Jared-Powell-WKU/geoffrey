#!/usr/bin/env bash
# Applies migrations/*.sql to a throwaway MariaDB that holds PRODUCTION-shaped
# tables (not defaults/, which already has the final shape) and checks that no
# data is lost and the deployed bot's SQL keeps working: first 001 and 002 on
# the original shape, then 003 on that result with duplicates of every kind
# seen in production. Then runs the internal
# API's integration test against the same database when it has been compiled
# (cd project/node && npm test).
#
#   ./test-migrations.sh
#   MARIADB_IMAGE=mariadb:11.8 ./test-migrations.sh    pin the image
#   SKIP_API_TEST=1 ./test-migrations.sh               migrations only
#
# One small container, reachable only through docker exec and 127.0.0.1, and
# always removed on exit together with its anonymous volume.
set -euo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="geoffrey-migration-test-$$"
PW="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
WORK="$(mktemp -d)"
D="timeout 120 docker"
FAILED=0

cleanup() {
    timeout 60 docker rm -f -v "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$3', got '$2'"; fi; }

sql() { $D exec -i -e MYSQL_PWD="$PW" "$NAME" mariadb -uroot -h127.0.0.1 --protocol=tcp --skip-ssl --default-character-set=utf8mb4 --batch --skip-column-names "$@"; }
# The way the deploy runner applies a migration: the file piped into `mariadb tncord`.
apply() { sql tncord < "$1"; }
q() { sql tncord -e "$1"; }

IMAGE=""
for candidate in ${MARIADB_IMAGE:-mariadb:12.1 mariadb:12 mariadb:11.8}; do
    if timeout 600 docker pull -q "$candidate" >/dev/null 2>&1; then IMAGE="$candidate"; break; fi
done
[ -n "$IMAGE" ] || { echo "No MariaDB image could be pulled."; exit 1; }
echo "Using $IMAGE"

$D run -d --name "$NAME" --memory 512m -p 127.0.0.1::3306 \
    -e MARIADB_ROOT_PASSWORD="$PW" -e MARIADB_DATABASE=tncord \
    "$IMAGE" --innodb-buffer-pool-size=64M --key-buffer-size=8M >/dev/null

# The entrypoint's bootstrap server has networking off, so a TCP login means the real server is up.
for i in $(seq 1 60); do
    if sql -e "SELECT 1" >/dev/null 2>&1; then break; fi
    [ "$i" = 60 ] && { echo "MariaDB did not start."; $D logs --tail 30 "$NAME"; exit 1; }
    sleep 2
done
echo "Server $(q "SELECT VERSION()"), sql_mode $(q "SELECT @@sql_mode")"

echo "Creating production-shaped tables and data"
sql tncord <<'SQL'
CREATE TABLE homies (url varchar(500) NOT NULL, guildId varchar(50) NOT NULL, userId varchar(50) DEFAULT NULL, PRIMARY KEY (url, guildId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
CREATE TABLE pets (url varchar(500) NOT NULL, guildId varchar(50) NOT NULL, userId varchar(50) DEFAULT NULL, PRIMARY KEY (url, guildId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
CREATE TABLE users (id varchar(100) NOT NULL, guildId varchar(100) NOT NULL, PRIMARY KEY (id, guildId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE inputoutput (name varchar(255) NOT NULL, value varchar(500) NOT NULL, guildId varchar(50) NOT NULL, userId varchar(50) DEFAULT NULL, lastUpdated timestamp NOT NULL DEFAULT current_timestamp(), PRIMARY KEY (name, guildId)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Attachment ids step by 1000 ms of snowflake time from a known id.
-- Unsigned (pre-2023 style) URLs, every tenth without a userId.
INSERT INTO homies SELECT CONCAT('https://cdn.discordapp.com/attachments/700000000000000001/', 1100000000000000000 + seq * 4194304000, '/image_', seq, '.png'), '500000000000000001', IF(seq % 10 = 0, NULL, CONCAT('60000000000000000', seq % 7)) FROM seq_0_to_199;
-- Signed URLs.
INSERT INTO homies SELECT CONCAT('https://cdn.discordapp.com/attachments/700000000000000002/', 1200000000000000000 + seq * 4194304000, '/IMG_', seq, '.jpg?ex=66f0', LPAD(HEX(seq), 4, '0'), '&is=66eeae80&hm=', SHA2(seq, 256), '&'), '500000000000000001', CONCAT('60000000000000000', seq % 7) FROM seq_0_to_149;
-- The same URL in a second guild, a media.discordapp.net row, the longest production length (389), and two shapes the backfill must leave alone.
INSERT INTO homies SELECT url, '500000000000000002', userId FROM homies WHERE url LIKE '%/image_1_.png';
INSERT INTO homies VALUES ('https://media.discordapp.net/attachments/700000000000000003/1100000000000000000/media.png', '500000000000000001', '600000000000000001');
INSERT INTO homies VALUES (RPAD('https://cdn.discordapp.com/attachments/700000000000000004/1100000000000000000/long_', 385, 'x'), '500000000000000001', '600000000000000001');
UPDATE homies SET url = CONCAT(url, '.png') WHERE url LIKE '%/long_%';
INSERT INTO homies VALUES ('https://cdn.discordapp.com/attachments/12/34/short_ids.png', '500000000000000001', '600000000000000001'), ('https://example.com/attachments/700000000000000001/1100000000000000000/elsewhere.png', '500000000000000001', NULL);
INSERT INTO pets SELECT CONCAT('https://cdn.discordapp.com/attachments/700000000000000005/', 1150000000000000000 + seq * 4194304000, '/pet_', seq, '.png', IF(seq % 2, CONCAT('?ex=66f0', LPAD(HEX(seq), 4, '0'), '&is=66eeae80&hm=', SHA2(seq, 256), '&'), '')), '500000000000000001', IF(seq % 25 = 0, NULL, CONCAT('60000000000000000', seq % 5)) FROM seq_0_to_149;
SQL
check "longest URL is 389 characters" "$(q "SELECT MAX(CHAR_LENGTH(url)) FROM homies")" "389"

snapshot() { q "SELECT '$1', HEX(url), guildId, IFNULL(userId, '<NULL>') FROM $1 ORDER BY 2, 3"; }
everything() { for t in homies pets; do q "SELECT * FROM $t ORDER BY id"; q "SHOW CREATE TABLE $t" | sed 's/ AUTO_INCREMENT=[0-9]*//'; done; q "SELECT category, id, url, guildId, userId, createdAt, source, channelId, messageId, reason, keptId FROM submissions_archive ORDER BY category, id" 2>/dev/null || true; }
snapshot homies > "$WORK/before"; snapshot pets >> "$WORK/before"
HOMIES_BEFORE="$(q "SELECT COUNT(*) FROM homies")"; PETS_BEFORE="$(q "SELECT COUNT(*) FROM pets")"
echo "Seeded $HOMIES_BEFORE homies and $PETS_BEFORE pets rows"

for f in "$HERE"/migrations/*.sql; do
    [[ "$(basename "$f")" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]] || fail "migration file name $(basename "$f")"
done
echo "Applying 001 and 002"
for f in "$HERE"/migrations/00[12]_*.sql; do
    apply "$f" && pass "applied $(basename "$f")" || fail "applying $(basename "$f")"
done

snapshot homies > "$WORK/after"; snapshot pets >> "$WORK/after"
check "homies row count unchanged" "$(q "SELECT COUNT(*) FROM homies")" "$HOMIES_BEFORE"
check "pets row count unchanged" "$(q "SELECT COUNT(*) FROM pets")" "$PETS_BEFORE"
if diff -q "$WORK/before" "$WORK/after" >/dev/null; then pass "every (url, guildId, userId) is byte-for-byte unchanged"; else fail "rows changed"; diff "$WORK/before" "$WORK/after" | head -10; fi
for t in homies pets; do
    check "$t ids are non-null, unique and positive" "$(q "SELECT CONCAT(COUNT(*) = COUNT(id), COUNT(*) = COUNT(DISTINCT id), MIN(id) > 0) FROM $t")" "111"
    check "$t primary key is still (url, guildId)" "$(q "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'tncord' AND TABLE_NAME = '$t' AND INDEX_NAME = 'PRIMARY'")" "url,guildId"
    check "$t url column type" "$(q "SELECT CONCAT(COLUMN_TYPE, ' ', COLLATION_NAME, ' ', IS_NULLABLE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'tncord' AND TABLE_NAME = '$t' AND COLUMN_NAME = 'url'")" "varchar(1024) ascii_bin NO"
    check "$t rows default to source discord" "$(q "SELECT GROUP_CONCAT(DISTINCT source) FROM $t")" "discord"
done

# 1100000000000000000 >> 22 = 262260437011; + 1420070400000 = 1682330837011 ms = 2023-04-24T10:07:17.011Z
check "known snowflake backfills to its UTC time" "$(q "SELECT CONCAT(createdAt, ' ', channelId) FROM homies WHERE url LIKE '%/image_0.png' AND guildId = '500000000000000001'")" "2023-04-24 10:07:17 700000000000000001"
check "one snowflake second later" "$(q "SELECT createdAt FROM homies WHERE url LIKE '%/image_1.png'")" "2023-04-24 10:07:18"
check "signed URL backfills from its path, not its query" "$(q "SELECT CONCAT(createdAt, ' ', channelId) FROM homies WHERE url LIKE '%/IMG_0.jpg?%'")" "$(q "SELECT CONCAT(FROM_UNIXTIME(((1200000000000000000 >> 22) + 1420070400000) DIV 1000), ' 700000000000000002')")"
check "media.discordapp.net row is backfilled" "$(q "SELECT CONCAT(createdAt, ' ', channelId) FROM homies WHERE url LIKE 'https://media.%'")" "2023-04-24 10:07:17 700000000000000003"
check "389-character row is backfilled" "$(q "SELECT createdAt FROM homies WHERE CHAR_LENGTH(url) = 389")" "2023-04-24 10:07:17"
check "short ids and other hosts are left alone" "$(q "SELECT COUNT(*) FROM homies WHERE createdAt IS NULL AND channelId IS NULL")" "2"
check "every other row has createdAt and channelId" "$(q "SELECT (SELECT COUNT(*) FROM homies WHERE createdAt IS NULL OR channelId IS NULL) + (SELECT COUNT(*) FROM pets WHERE createdAt IS NULL OR channelId IS NULL)")" "2"
check "backfill does not depend on the server time zone" "$(q "SET time_zone = '-05:00'; SELECT createdAt FROM homies WHERE url LIKE '%/image_0.png' AND guildId = '500000000000000001'")" "2023-04-24 10:07:17"

echo "The currently deployed bot's statements"
OLD_URL="https://cdn.discordapp.com/attachments/700000000000000001/1300000000000000000/old_bot.png?ex=66f00000&is=66eeae80&hm=abc&"
q "INSERT INTO homies (url, guildId, userId) VALUES ('$OLD_URL', '500000000000000001', '600000000000000001')" && pass "old-style insert works" || fail "old-style insert"
check "old-style row gets an id and defaults" "$(q "SELECT CONCAT(id > 0, ' ', source, ' ', IFNULL(createdAt, 'NULL')) FROM homies WHERE url = '$OLD_URL'")" "1 discord NULL"
if q "INSERT INTO homies (url, guildId, userId) VALUES ('$OLD_URL', '500000000000000001', '600000000000000002')" 2>"$WORK/dup"; then fail "duplicate insert was accepted"; else grep -q "Duplicate entry" "$WORK/dup" && pass "duplicate insert fails on the primary key" || { fail "duplicate insert failed for another reason"; cat "$WORK/dup"; }; fi
check "lookup by (url, guildId) uses the primary key" "$(q "EXPLAIN SELECT 1 FROM homies WHERE url = '$OLD_URL' AND guildId = '500000000000000001'" | awk -F'\t' '{print $4, $6}')" "const PRIMARY"
check "old-style delete removes the row" "$(q "DELETE FROM homies WHERE url = '$OLD_URL' AND guildId = '500000000000000001'; SELECT ROW_COUNT()")" "1"
check "random roll by user still works" "$(q "SELECT COUNT(*) FROM (SELECT url FROM pets WHERE guildId = '500000000000000001' AND userId = '600000000000000001' ORDER BY RAND() LIMIT 1) r")" "1"
check "listing query uses the listing index" "$(q "EXPLAIN SELECT id FROM homies WHERE guildId = '500000000000000001' AND userId = '600000000000000001' ORDER BY createdAt DESC, id DESC LIMIT 49" | awk -F'\t' '{print $6}')" "homies_listing_IDX"
q "INSERT INTO pets (url, guildId) VALUES (CONCAT('https://example.com/', REPEAT('a', 1004)), '500000000000000001')" && pass "a 1024-character URL fits" || fail "1024-character URL"
if q "INSERT INTO pets (url, guildId) VALUES (CONCAT('https://example.com/', REPEAT('a', 1005)), '500000000000000001')" 2>/dev/null; then fail "a 1025-character URL was accepted"; else pass "a 1025-character URL is rejected, not truncated"; fi
NON_ASCII="$(printf 'https://example.com/caf\303\251.png')"
if q "INSERT INTO pets (url, guildId) VALUES ('$NON_ASCII', '500000000000000001')" 2>/dev/null; then fail "a non-ASCII URL was accepted"; else pass "a non-ASCII URL is rejected, not mangled"; fi
q "DELETE FROM pets WHERE url LIKE 'https://example.com/%'"

echo "Seeding duplicates as production has them after 001 and 002"
# messageId carries a label: keep-<case> must survive 003, drop-<case>[-n] must be
# archived with keptId pointing at keep-<case>. Ids rise in insertion order.
G3=500000000000000003; G4=500000000000000004
A="https://cdn.discordapp.com/attachments/700000000000000009"; M="https://media.discordapp.net/attachments/700000000000000009"
OLD="?ex=66f00000&is=66eeae80&hm=abc&"; NEW="?ex=688eb000&is=688d5e80&hm=def&"
row() { echo "('$1', '$G3', $2, '2024-01-01 00:00:00', '${4:-discord}', '700000000000000009', '$3')"; }
sql tncord <<SQL
INSERT INTO homies (url, guildId, userId, createdAt, source, channelId, messageId) VALUES
-- unsigned original + re-import copy, same owner
$(row "$A/1400000000000000001/a.png" "'u1'" drop-A), $(row "$A/1400000000000000001/a.png$NEW" "'u1'" keep-A),
-- two signed copies; the later ex wins although its id is smaller
$(row "$A/1400000000000000002/b.png$NEW" "'u1'" keep-B), $(row "$A/1400000000000000002/b.png$OLD" "'u1'" drop-B),
-- ownerless unsigned original + owned copy
$(row "$A/1400000000000000003/c.png" NULL drop-C), $(row "$A/1400000000000000003/c.png$NEW" "'u1'" keep-C),
-- an owner beats a later ex and a larger id
$(row "$A/1400000000000000004/c2.png$OLD" "'u1'" keep-C2), $(row "$A/1400000000000000004/c2.png$NEW" NULL drop-C2),
-- two different owners: the later-ex copy names the real author
$(row "$A/1400000000000000005/d.png$NEW" "'u2'" keep-D), $(row "$A/1400000000000000005/d.png$OLD" "'u1'" drop-D),
-- the same attachment under both hosts
$(row "$M/1400000000000000006/e.png$NEW" "'u1'" keep-E), $(row "$A/1400000000000000006/e.png" "'u1'" drop-E),
$(row "$A/1400000000000000007/f.png" "'u1'" drop-F), $(row "$M/1400000000000000007/f.png" "'u1'" keep-F),
-- an unreadable ex counts as unsigned, so the larger id decides
$(row "$A/1400000000000000008/k.png?ex=zz&is=1&hm=2&" "'u1'" drop-K), $(row "$A/1400000000000000008/k.png" "'u1'" keep-K),
-- three copies
$(row "$A/1400000000000000009/l.png" "'u1'" drop-L-1), $(row "$A/1400000000000000009/l.png$OLD" "'u1'" drop-L-2), $(row "$A/1400000000000000009/renamed.png$NEW" "'u1'" keep-L),
-- ex is not the first parameter
$(row "$A/1400000000000000010/m.png?is=688d5e80&ex=688eb000&hm=def&" "'u1'" keep-M), $(row "$A/1400000000000000010/m.png$OLD" "'u1'" drop-M),
-- not duplicates: another attachment, a web-added URL, two URLs that differ only in the query, look-alikes
$(row "$A/1400000000000000011/a.png" "'u1'" keep-N),
$(row "https://example.com/web.png" "'u1'" keep-I0 web),
$(row "https://example.com/i.php?id=1" "'u1'" keep-I1 web), $(row "https://example.com/i.php?id=2" "'u1'" keep-I2 web),
$(row "https://example.com/attachments/700000000000000009/1400000000000000001/a.png$OLD" "'u1'" keep-J1), $(row "https://example.com/attachments/700000000000000009/1400000000000000001/a.png$NEW" "'u1'" keep-J2),
$(row "https://cdn.discordapp.com/avatars/700000000000000009/1400000000000000001/a.png?size=64" "'u1'" keep-J3), $(row "https://cdn.discordapp.com/avatars/700000000000000009/1400000000000000001/a.png?size=128" "'u1'" keep-J4),
$(row "https://cdn.discordapp.com/attachments/abc/def/a.png?x=1" "'u1'" keep-J5), $(row "https://cdn.discordapp.com/attachments/abc/def/a.png?x=2" "'u1'" keep-J6);
-- the same attachment in another guild and in the other table is not a duplicate
INSERT INTO homies (url, guildId, userId, createdAt, channelId, messageId) VALUES ('$A/1400000000000000001/a.png', '$G4', 'u1', '2024-01-01 00:00:00', '700000000000000009', 'keep-G');
INSERT INTO pets (url, guildId, userId, createdAt, source, channelId, messageId) VALUES
$(row "$A/1400000000000000001/a.png" "'u1'" keep-H),
-- the pets pair seen in production: same attachment id, cdn vs media
$(row "$A/1400000000000000020/p.png$OLD" "'u1'" drop-P), $(row "$M/1400000000000000020/p.png$NEW" "'u1'" keep-P);
SQL
KEEPS="keep-A,keep-B,keep-C,keep-C2,keep-D,keep-E,keep-F,keep-G,keep-H,keep-I0,keep-I1,keep-I2,keep-J1,keep-J2,keep-J3,keep-J4,keep-J5,keep-J6,keep-K,keep-L,keep-M,keep-N,keep-P"
DROPS="drop-A,drop-B,drop-C,drop-C2,drop-D,drop-E,drop-F,drop-K,drop-L-1,drop-L-2,drop-M,drop-P"
ROWCOLS="id, HEX(url), guildId, IFNULL(userId, '<NULL>'), IFNULL(createdAt, '<NULL>'), source, IFNULL(channelId, '<NULL>'), IFNULL(messageId, '<NULL>')"
allrows() { q "SELECT 'homies', $ROWCOLS FROM homies UNION ALL SELECT 'pets', $ROWCOLS FROM pets ${1:-} ORDER BY 1, 2"; }
allrows > "$WORK/before003"
TOTAL_BEFORE="$(wc -l < "$WORK/before003" | tr -d ' ')"
echo "  $TOTAL_BEFORE rows before 003"

echo "Applying 003"
for f in "$HERE"/migrations/00[3-9]_*.sql "$HERE"/migrations/0[1-9][0-9]_*.sql; do
    [ -f "$f" ] || continue
    apply "$f" && pass "applied $(basename "$f")" || fail "applying $(basename "$f")"
done
for t in homies pets; do
    check "$t has exactly one row per (guildId, mediaKey)" "$(q "SELECT COUNT(*) FROM (SELECT 1 FROM $t GROUP BY guildId, mediaKey HAVING COUNT(*) > 1) d")" "0"
    check "$t has the unique key (guildId, mediaKey)" "$(q "SELECT CONCAT(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX), ' ', MAX(NON_UNIQUE)) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'tncord' AND TABLE_NAME = '$t' AND INDEX_NAME = '${t}_media_UK'")" "guildId,mediaKey 0"
    check "$t primary key is still (url, guildId)" "$(q "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'tncord' AND TABLE_NAME = '$t' AND INDEX_NAME = 'PRIMARY'")" "url,guildId"
done
LABELLED="SELECT messageId FROM homies WHERE messageId LIKE 'keep-%' OR messageId LIKE 'drop-%' UNION ALL SELECT messageId FROM pets WHERE messageId LIKE 'keep-%' OR messageId LIKE 'drop-%'"
check "the survivor of every case is the right one" "$(q "SELECT GROUP_CONCAT(messageId ORDER BY messageId) FROM ($LABELLED) l")" "$KEEPS"
check "exactly the other copies are archived as duplicates" "$(q "SELECT GROUP_CONCAT(messageId ORDER BY messageId) FROM submissions_archive WHERE reason = 'duplicate'")" "$DROPS"
check "every archived copy points at its survivor" "$(q "SELECT COUNT(*) FROM submissions_archive a JOIN (SELECT 'homies' AS category, id, guildId, messageId FROM homies UNION ALL SELECT 'pets', id, guildId, messageId FROM pets) k ON k.category = a.category AND k.id = a.keptId AND k.guildId = a.guildId WHERE a.reason = 'duplicate' AND k.messageId = CONCAT('keep-', SUBSTRING_INDEX(SUBSTRING_INDEX(a.messageId, '-', 2), '-', -1))")" "12"
check "archived rows carry a time and nothing else was archived" "$(q "SELECT CONCAT(COUNT(*), ' ', SUM(archivedAt IS NOT NULL), ' ', SUM(keptId IS NULL)) FROM submissions_archive")" "12 12 0"
q "SELECT category, $ROWCOLS FROM submissions_archive" > "$WORK/archived003"
allrows > "$WORK/live003"
sort "$WORK/live003" "$WORK/archived003" > "$WORK/after003"; sort "$WORK/before003" > "$WORK/before003.sorted"
if diff -q "$WORK/before003.sorted" "$WORK/after003" >/dev/null; then pass "live + archived rows are the $TOTAL_BEFORE original rows, byte for byte"; else fail "rows were lost or changed by 003"; diff "$WORK/before003.sorted" "$WORK/after003" | head -10; fi
check "mediaKey of a Discord attachment and of a look-alike" "$(q "SELECT GROUP_CONCAT(mediaKey ORDER BY messageId SEPARATOR ' ') FROM homies WHERE messageId IN ('keep-E', 'keep-J3')")" "discord:700000000000000009/1400000000000000006 https://cdn.discordapp.com/avatars/700000000000000009/1400000000000000001/a.png?size=64"

echo "Second copies after 003"
if q "INSERT INTO homies (url, guildId, userId) VALUES ('$A/1400000000000000001/a.png?ex=69000000&is=68ff0000&hm=123&', '$G3', 'u9')" 2>"$WORK/dup2"; then fail "the old-style insert of a second copy was accepted"; else grep -q "Duplicate entry.*homies_media_UK" "$WORK/dup2" && pass "the old-style insert of a second copy fails cleanly on homies_media_UK" || { fail "second copy failed for another reason"; cat "$WORK/dup2"; }; fi
# The statement insertAttachmentsSql() in node/src/util/submissionSql.ts builds (the API integration test runs the real builder).
q "INSERT INTO homies (url, guildId, userId, channelId, messageId, createdAt) VALUES ('$A/1400000000000000001/a.png?ex=69000000&is=68ff0000&hm=123&', '$G3', 'u9', '7', 'again', '2025-01-01 00:00:00'), ('$A/1400000000000000099/new.png', '$G3', 'u9', '7', 'fresh', '2025-01-01 00:00:00') ON DUPLICATE KEY UPDATE userId = userId" && pass "the new saveAttachments statement accepts a batch that contains a second copy" || fail "new saveAttachments statement"
check "...storing only what is new and leaving the stored copy untouched" "$(q "SELECT GROUP_CONCAT(CONCAT(messageId, ':', userId) ORDER BY id SEPARATOR ' ') FROM homies WHERE guildId = '$G3' AND mediaKey IN ('discord:700000000000000009/1400000000000000001', 'discord:700000000000000009/1400000000000000099')")" "keep-A:u1 fresh:u9"
q "DELETE FROM homies WHERE messageId = 'fresh'"

echo "Re-running every migration"
everything > "$WORK/first"
for f in "$HERE"/migrations/*.sql; do apply "$f" || fail "re-applying $(basename "$f")"; done
everything > "$WORK/second"
if diff -q "$WORK/first" "$WORK/second" >/dev/null; then pass "a second run changes no data and no DDL"; else fail "second run changed something"; diff "$WORK/first" "$WORK/second" | head -10; fi
# What an interrupted 003 leaves behind: an archive copy of a row that is still live. The next run must drop it and decide afresh.
q "INSERT INTO submissions_archive (category, id, url, guildId, reason, keptId) SELECT 'homies', id, url, guildId, 'duplicate', id FROM homies WHERE messageId = 'keep-A'"
apply "$HERE/migrations/003_dedupe_media.sql" || fail "re-applying 003 after an interrupted run"
everything > "$WORK/third"
if diff -q "$WORK/first" "$WORK/third" >/dev/null; then pass "a run after an interrupted one leaves the live row alone and drops its stale archive copy"; else fail "interrupted-run recovery"; diff "$WORK/first" "$WORK/third" | head -10; fi

echo "Fresh install from defaults/"
sql -e "CREATE DATABASE fresh"
for f in "$HERE"/defaults/*.sql; do sed 's/tncord\./fresh./g' "$f" | sql fresh || fail "defaults/$(basename "$f")"; done
shape() { sql -e "SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, IFNULL(COLUMN_DEFAULT, '<none>'), IFNULL(COLLATION_NAME, '-'), EXTRA, IFNULL(GENERATION_EXPRESSION, '-') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '$1' AND TABLE_NAME IN ('homies', 'pets', 'submissions_archive') ORDER BY 1, 3; SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '$1' AND TABLE_NAME IN ('homies', 'pets', 'submissions_archive') ORDER BY 1, 2, 4; SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$1' AND TABLE_NAME IN ('homies', 'pets', 'submissions_archive') ORDER BY 1"; }
shape tncord > "$WORK/migrated"; shape fresh > "$WORK/fresh"
if diff -q "$WORK/migrated" "$WORK/fresh" >/dev/null; then pass "defaults/ homies, pets and submissions_archive match the migrated production shape"; else fail "defaults/ differ from the migrated shape"; diff "$WORK/migrated" "$WORK/fresh" | head -20; fi
check "fresh install marks the migrations as applied" "$(sql fresh -e "SELECT GROUP_CONCAT(name ORDER BY name) FROM schema_migrations")" "$(cd "$HERE/migrations" && ls *.sql | sort | paste -sd, -)"
check "fresh install has inputoutput.lastUpdated" "$(sql fresh -e "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'fresh' AND TABLE_NAME = 'inputoutput' AND COLUMN_NAME = 'lastUpdated'")" "timestamp"

API_TEST="$HERE/../node/dist/test/integration.test.js"
if [ -n "${SKIP_API_TEST:-}" ]; then
    echo "Skipping the API integration test (SKIP_API_TEST)"
elif [ ! -f "$API_TEST" ]; then
    echo "  SKIP  API integration test: $API_TEST not built (cd project/node && npm test)"
else
    echo "API integration test against the migrated database"
    PORT="$($D port "$NAME" 3306/tcp | head -1 | sed 's/.*://')"
    if (cd "$HERE/../node" && TEST_DB_HOST=127.0.0.1 TEST_DB_PORT="$PORT" TEST_DB_USER=root TEST_DB_PASSWORD="$PW" TEST_DB_NAME=tncord timeout 120 node --test dist/test/integration.test.js) > "$WORK/api" 2>&1; then
        # A skipped suite also exits 0, so insist that tests really ran.
        RAN="$(grep -Eo 'pass [0-9]+' "$WORK/api" | tr -dc '0-9')"; SKIPPED="$(grep -Eo 'skipped [0-9]+' "$WORK/api" | tr -dc '0-9')"
        if [ "${RAN:-0}" -ge 10 ] && [ "${SKIPPED:-1}" = 0 ]; then pass "API integration test ($RAN passed, $SKIPPED skipped)"; else fail "API integration test did not run"; cat "$WORK/api"; fi
    else
        fail "API integration test"; cat "$WORK/api"
    fi
fi

if [ "$FAILED" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
