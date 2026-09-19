// Runs the API's real SQL against a migrated MariaDB. Skipped unless
// TEST_DB_PORT is set; project/mariadb/test-migrations.sh sets it.
import { test, describe, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as mariadb from "mariadb";
import { createInternalApi } from "../internalApi";
import { archiveAndDelete, archiveAndDeleteSql, mediaKey, QueryFn, removeImageByUrl, removeImagesForMessages, TransactionFn } from "../util/imageRemoval";
import { createDbAccess } from "../util/dbAccess";
import { insertAttachmentsSql } from "../util/submissionSql";
import { FakeDiscord, GUILDS, GUILD, KEY, listen, makeRequester, MEDIA_KEY_CASES, OTHER_USER, OWN_KEY_CASES, USER } from "./helpers";

const {TEST_DB_PORT, TEST_DB_HOST, TEST_DB_USER, TEST_DB_PASSWORD, TEST_DB_NAME} = process.env;

describe("internal API against MariaDB", {skip: TEST_DB_PORT ? false : "TEST_DB_PORT is not set"}, () => {
    let pool: mariadb.Pool;
    let server: http.Server;
    let request: ReturnType<typeof makeRequester>;
    const discord = new FakeDiscord();
    const list = (query: string) => `/v1/guilds/${GUILD}/submissions?${query}`;

    // The bot's own query and transaction helpers, over this test's pool
    // (util/util.ts cannot be imported: its pool comes from the bot's environment).
    let db: ReturnType<typeof createDbAccess>;
    const query: QueryFn = (sql, params) => db.query(sql, params);
    const transaction: TransactionFn = (work) => db.transaction(work);

    before(async () => {
        pool = mariadb.createPool({host: TEST_DB_HOST || "127.0.0.1", port: Number(TEST_DB_PORT), user: TEST_DB_USER || "root", password: TEST_DB_PASSWORD, database: TEST_DB_NAME || "tncord", connectionLimit: 2});
        db = createDbAccess(pool);
        for(const table of ["homies", "pets"]) await query(`DELETE FROM ${table} WHERE guildId = ?`, [GUILD]);
        // What the updated saveAttachments sends, two attachments on one message.
        await query("INSERT INTO homies (url, guildId, userId, channelId, messageId, createdAt) VALUES (?,?,?,?,?,?), (?,?,?,?,?,?)", [
            "https://cdn.discordapp.com/attachments/300000000000000001/1100000000000000001/one.png?ex=66f00000&is=66eeae80&hm=abc&", GUILD, USER, "300000000000000001", "400000000000000001", "2024-06-01 12:00:00",
            "https://cdn.discordapp.com/attachments/300000000000000001/1100000000000000002/two.png?ex=66f00000&is=66eeae80&hm=abc&", GUILD, USER, "300000000000000001", "400000000000000001", "2024-06-01 12:00:00"
        ]);
        const values: unknown[] = [];
        for(let i = 0; i < 60; i++) {
            // Ties on createdAt, a block of unknown dates, and another user's rows in between.
            const createdAt = i % 4 === 0 ? null : `2024-03-${String(1 + (i % 9)).padStart(2, "0")} 08:00:00`;
            values.push(`https://example.com/integration/${i}.png`, GUILD, i % 6 === 5 ? OTHER_USER : USER, createdAt);
        }
        await query(`INSERT INTO homies (url, guildId, userId, createdAt) VALUES ${"(?,?,?,?),".repeat(60).slice(0, -1)}`, values);
        await query("INSERT INTO homies (url, guildId, userId) VALUES (?,?,NULL)", ["https://example.com/integration/orphan.png", GUILD]);

        server = createInternalApi({config: {key: KEY, guilds: GUILDS}, query, transaction, discord, log: {info: () => {}, warn: () => {}, error: console.error}});
        request = makeRequester(await listen(server));
    });

    after(async () => {
        server?.closeAllConnections();
        await new Promise(resolve => server ? server.close(resolve) : resolve(null));
        await pool?.end();
    });

    test("listing pages through exactly the user's rows in the contract's order", async () => {
        const expected: any[] = await query("SELECT CAST(id AS CHAR) AS id FROM homies WHERE guildId = ? AND userId = ? ORDER BY createdAt IS NULL, createdAt DESC, id DESC", [GUILD, USER]);
        assert.equal(expected.length, 52);
        const seen: any[] = [];
        let cursor: string|null = null;
        do {
            const res: any = await request("GET", list(`userId=${USER}&category=homies&limit=7` + (cursor ? `&cursor=${cursor}` : "")));
            assert.equal(res.status, 200);
            assert.equal(res.body.total, 52);
            seen.push(...res.body.items);
            cursor = res.body.nextCursor;
        } while(cursor);
        assert.deepEqual(seen.map(i => i.id), expected.map(r => r.id));
        assert.equal(seen[0].createdAt, "2024-06-01T12:00:00Z");
        assert.equal(seen[seen.length - 1].createdAt, null);
        for(const item of seen) {
            assert.equal(typeof item.id, "string");
            assert.equal(typeof item.url, "string");
            assert.equal(item.source, "discord");
        }
        // The expired signed CDN rows were sent for refreshing; nothing else was.
        assert.deepEqual([...new Set(discord.refreshCalls.flat())].sort(), seen.filter(i => i.url.includes("discordapp")).map(i => i.url).sort());
    });

    test("add stores a web row with a UTC timestamp, and a duplicate is 409", async () => {
        const url = "https://example.com/integration/" + "w".repeat(1024 - "https://example.com/integration/".length);
        const before = Date.now();
        const res = await request("POST", `/v1/guilds/${GUILD}/submissions`, {body: {userId: USER, category: "homies", url}});
        assert.equal(res.status, 201);
        assert.equal(res.body.item.url, url);
        assert.equal(res.body.item.source, "web");
        assert.match(res.body.item.id, /^[0-9]+$/);
        const created = Date.parse(res.body.item.createdAt);
        assert.ok(Math.abs(created - before) < 5000, `createdAt ${res.body.item.createdAt} is not now in UTC`);
        const stored: any[] = await query("SELECT source, userId, channelId, messageId FROM homies WHERE id = ?", [res.body.item.id]);
        assert.deepEqual({...stored[0]}, {source: "web", userId: USER, channelId: null, messageId: null});
        assert.equal((await query("SELECT COUNT(*) AS n FROM users WHERE id = ? AND guildId = ?", [USER, GUILD]))[0].n, 1n);

        const again = await request("POST", `/v1/guilds/${GUILD}/submissions`, {body: {userId: OTHER_USER, category: "homies", url}});
        assert.equal(again.status, 409);
        // ascii_bin makes the key case-sensitive, so a different case is a different URL.
        const upper = await request("POST", `/v1/guilds/${GUILD}/submissions`, {body: {userId: USER, category: "homies", url: url.replace("/integration/", "/INTEGRATION/")}});
        assert.equal(upper.status, 201);
        const first = await request("GET", list(`userId=${USER}&category=homies&limit=2`));
        assert.deepEqual(first.body.items.map((i: any) => i.id).sort(), [res.body.item.id, upper.body.item.id].sort());
    });

    test("delete is scoped to the owner, and the reaction goes with the message's last row", async () => {
        const theirs: any[] = await query("SELECT CAST(id AS CHAR) AS id FROM homies WHERE guildId = ? AND userId = ? LIMIT 1", [GUILD, OTHER_USER]);
        const orphan: any[] = await query("SELECT CAST(id AS CHAR) AS id FROM homies WHERE guildId = ? AND userId IS NULL LIMIT 1", [GUILD]);
        for(const id of [theirs[0].id, orphan[0].id]) {
            assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${id}?userId=${USER}`)).status, 404);
            assert.equal((await query("SELECT COUNT(*) AS n FROM homies WHERE id = ?", [id]))[0].n, 1n);
        }
        const message: any[] = await query("SELECT CAST(id AS CHAR) AS id FROM homies WHERE guildId = ? AND messageId = ? ORDER BY id", [GUILD, "400000000000000001"]);
        assert.equal(message.length, 2);
        assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/pets/${message[0].id}?userId=${USER}`)).status, 404);
        assert.deepEqual(await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${message[0].id}?userId=${USER}`), {status: 200, body: {deleted: true}});
        assert.equal(discord.reactionsRemoved.length, 0);
        assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${message[1].id}?userId=${USER}`)).status, 200);
        assert.deepEqual(discord.reactionsRemoved, [{channelId: "300000000000000001", messageId: "400000000000000001"}]);
        assert.equal((await query("SELECT COUNT(*) AS n FROM homies WHERE guildId = ? AND messageId = ?", [GUILD, "400000000000000001"]))[0].n, 0n);
        assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${message[1].id}?userId=${USER}`)).status, 404);
        // Removed on the site means archived, not gone.
        const archived: any[] = await query("SELECT CAST(id AS CHAR) AS id, reason, userId, messageId FROM submissions_archive WHERE category = 'homies' AND id IN (?,?) ORDER BY id", [message[0].id, message[1].id]);
        assert.deepEqual(archived.map(a => ({...a})), message.map(m => ({id: m.id, reason: "removed_on_site", userId: USER, messageId: "400000000000000001"})));
    });

    test("the same Discord attachment under another signature or host is 409", async () => {
        const base = "https://cdn.discordapp.com/attachments/300000000000000001/1100000000000000777/web.png";
        assert.equal((await request("POST", `/v1/guilds/${GUILD}/submissions`, {body: {userId: USER, category: "homies", url: `${base}?ex=66f00000&is=66eeae80&hm=abc&`}})).status, 201);
        for(const again of [base, `${base}?ex=77777777&is=77777000&hm=def&`, base.replace("cdn.discordapp.com", "media.discordapp.net")]) {
            const res = await request("POST", `/v1/guilds/${GUILD}/submissions`, {body: {userId: OTHER_USER, category: "homies", url: again}});
            assert.equal(res.status, 409, again);
            assert.equal(res.body.error.code, "DUPLICATE");
        }
        assert.equal((await query("SELECT COUNT(*) AS n FROM homies WHERE guildId = ? AND mediaKey = ?", [GUILD, mediaKey(base)]))[0].n, 1n);
        // The pets table is a separate collection.
        assert.equal((await request("POST", `/v1/guilds/${GUILDS.clantus.guildId}/submissions`, {body: {userId: USER, category: "pets", url: base}})).status, 201);
        await query("DELETE FROM pets WHERE guildId = ?", [GUILDS.clantus.guildId]);
    });

    describe("media identity, archive-then-delete and removal", () => {
        const RG = "100000000000000777";
        const ELSEWHERE = "100000000000000778";
        const FILLER = "100000000000000779";
        const KEYS = "1000000000000008";
        const cdn = "https://cdn.discordapp.com/attachments/300000000000000009/";
        const COLUMNS = "CAST(id AS CHAR) AS id, url, guildId, userId, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') AS createdAt, source, channelId, messageId";
        const live = async (guildId: string = RG) => (await query("SELECT url FROM homies WHERE guildId = ? UNION ALL SELECT url FROM pets WHERE guildId = ? ORDER BY 1", [guildId, guildId]) as any[]).map(r => r.url);
        const archivedFor = async (guildId: string = RG) => (await query(`SELECT category, reason, ${COLUMNS} FROM submissions_archive WHERE guildId = ? ORDER BY category, id`, [guildId]) as any[]).map(r => ({...r}));
        const add = (table: string, url: string, guildId: string = RG, messageId: string|null = null, userId: string|null = USER) =>
            query(`INSERT INTO ${table} (url, guildId, userId, messageId, channelId, createdAt) VALUES (?,?,?,?,?,?)`, [url, guildId, userId, messageId, messageId ? "300000000000000009" : null, messageId ? "2025-01-02 03:04:05" : null]);

        before(async () => {
            for(const table of ["homies", "pets", "submissions_archive"]) await query(`DELETE FROM ${table} WHERE guildId IN (?,?,?) OR guildId LIKE ?`, [RG, ELSEWHERE, FILLER, `${KEYS}%`]);
        });

        test("the generated mediaKey column agrees with mediaKey() on every tricky URL", async () => {
            const cases = [...MEDIA_KEY_CASES.map(([url]) => url), ...OWN_KEY_CASES];
            // One guild per URL: several of them are, on purpose, the same picture.
            for(const [i, url] of cases.entries()) await query("INSERT INTO homies (url, guildId) VALUES (?, ?)", [url, `${KEYS}${String(i).padStart(2, "0")}`]);
            const rows: any[] = await query("SELECT url, mediaKey FROM homies WHERE guildId LIKE ? ORDER BY guildId", [`${KEYS}%`]);
            assert.equal(rows.length, cases.length);
            for(const row of rows) assert.equal(row.mediaKey, mediaKey(row.url), row.url);
            for(const [url, key] of MEDIA_KEY_CASES) assert.equal(rows.find(r => r.url === url).mediaKey, key);
            await query("DELETE FROM homies WHERE guildId LIKE ?", [`${KEYS}%`]);
        });

        test("saving attachments skips a copy that is already stored, and still fails on a real error", async () => {
            const stored = `${cdn}1100000000000000101/first.png`;
            await add("homies", stored, RG, null, null);
            const again = `${cdn}1100000000000000101/first.png?ex=77777777&is=77777000&hm=abc&`;
            const fresh = `${cdn}1100000000000000102/second.png?ex=77777777&is=77777000&hm=abc&`;
            // What the deployed bot sent before this change now fails cleanly on the new key...
            await assert.rejects(query("INSERT INTO homies (url, guildId, userId) VALUES (?,?,?)", [again, RG, USER]), (e: any) => e.errno === 1062 && /homies_media_UK/.test(e.message));
            // ...while the new statement stores what is new and leaves the stored copy exactly as it was.
            const row = (url: string) => [url, RG, USER, "300000000000000009", "400000000000000100", "2025-05-05 05:05:05"];
            await query(insertAttachmentsSql("homies", 2), [...row(again), ...row(fresh)]);
            const rows: any[] = await query("SELECT url, userId, messageId FROM homies WHERE guildId = ? ORDER BY url", [RG]);
            assert.deepEqual(rows.map(r => ({...r})), [{url: stored, userId: null, messageId: null}, {url: fresh, userId: USER, messageId: "400000000000000100"}]);
            await query(insertAttachmentsSql("homies", 2), [...row(again), ...row(fresh)]);
            assert.equal((await live()).length, 2);
            // Unlike INSERT IGNORE, other errors still surface.
            await assert.rejects(query(insertAttachmentsSql("homies", 1), row("https://example.com/" + "a".repeat(1010))), /too long/i);
            await query("DELETE FROM homies WHERE guildId = ?", [RG]);
        });

        test("archive-then-delete keeps an exact copy, and leaves no copy behind when the delete fails", async () => {
            const url = `${cdn}1100000000000000201/tx.png?ex=66f00000&is=66eeae80&hm=aaa&`;
            await add("pets", url, RG, "400000000000000201");
            const [original]: any[] = await query(`SELECT ${COLUMNS} FROM pets WHERE guildId = ?`, [RG]);

            const failingDelete: TransactionFn = (work) => transaction((inTransaction) => work(async (sql, params) => {
                if(sql.startsWith("DELETE")) throw new Error("the delete failed");
                return inTransaction(sql, params);
            }));
            await assert.rejects(failingDelete((q) => archiveAndDelete(q, "pets", "message_deleted", "t.guildId = ?", [RG])), /the delete failed/);
            assert.deepEqual(await archivedFor(), []);
            assert.deepEqual(await live(), [url]);

            assert.equal(await transaction((q) => archiveAndDelete(q, "pets", "message_deleted", "t.guildId = ?", [RG])), 1);
            assert.deepEqual(await live(), []);
            assert.deepEqual(await archivedFor(), [{category: "pets", reason: "message_deleted", ...original}]);
            const [meta]: any[] = await query("SELECT keptId, TIMESTAMPDIFF(SECOND, archivedAt, CURRENT_TIMESTAMP) AS age FROM submissions_archive WHERE guildId = ?", [RG]);
            assert.equal(meta.keptId, null);
            assert.ok(Number(meta.age) >= 0 && Number(meta.age) < 60);
            assert.equal(await transaction((q) => archiveAndDelete(q, "pets", "message_deleted", "t.guildId = ?", [RG])), 0);
        });

        test("a deleted message takes its rows with it: by messageId, and legacy rows by mediaKey", async () => {
            const signed = `${cdn}1100000000000000301/my_pic%20v2.png?ex=66f00000&is=66eeae80&hm=aaa&`;
            const unsigned = `${cdn}1100000000000000302/plain.png`;
            const media = "https://media.discordapp.net/attachments/300000000000000009/1100000000000000303/old.png";
            const survivors = [
                `${cdn}1100000000000000304/my_pic%20v2.png?ex=66f00000&is=66eeae80&hm=aaa&`,     // same file name, another attachment
                `${cdn}1100000000000000305/owned-by-another-message.png`,
                "https://example.com/attachments/300000000000000009/1100000000000000301/my_pic%20v2.png"
            ];
            await add("homies", signed);
            await add("pets", unsigned);
            await add("homies", media);
            await add("homies", survivors[0]);
            await add("homies", survivors[1], RG, "400000000000000399");
            await add("homies", survivors[2]);
            await add("homies", signed, ELSEWHERE);
            await add("pets", unsigned, ELSEWHERE);
            await add("pets", `${cdn}1100000000000000310/new-a.png?ex=66f00000&is=66eeae80&hm=aaa&`, RG, "400000000000000310");
            await add("pets", `${cdn}1100000000000000311/new-b.png?ex=66f00000&is=66eeae80&hm=aaa&`, RG, "400000000000000310");
            await add("pets", `${cdn}1100000000000000312/new-c.png`, RG, "400000000000000311");
            await add("pets", `${cdn}1100000000000000313/new-d.png`, ELSEWHERE, "400000000000000310");

            // Uncached: the event carries ids only.
            assert.equal(await removeImagesForMessages(transaction, RG, ["400000000000000310"], [], "message_deleted"), 2);
            // Cached: what the message carried when it went, freshly signed, plus proxy forms.
            // The attachment of the row that belongs to another message is offered too and must not match.
            assert.equal(await removeImagesForMessages(transaction, RG, ["400000000000000300"], [
                `${cdn}1100000000000000301/my_pic%20v2.png?ex=77777777&is=77777000&hm=bbb&`,
                "https://media.discordapp.net/attachments/300000000000000009/1100000000000000301/my_pic%20v2.png?ex=77777777&is=77777000&hm=bbb&",
                `${cdn}1100000000000000302/plain.png?ex=77777777&is=77777000&hm=ccc&`,
                `${cdn}1100000000000000303/old.png?ex=77777777&is=77777000&hm=ddd&`,
                `${cdn}1100000000000000305/owned-by-another-message.png?ex=77777777&is=77777000&hm=eee&`
            ], "message_deleted"), 3);
            // Bulk: several ids at once, one of them unknown.
            assert.equal(await removeImagesForMessages(transaction, RG, ["400000000000000311", "400000000000000999"], [], "message_deleted"), 1);

            assert.deepEqual(await live(), [...survivors].sort());
            assert.deepEqual((await live(ELSEWHERE)).length, 3);
            assert.deepEqual(await archivedFor(ELSEWHERE), []);
            const gone = (await archivedFor()).filter(a => a.reason === "message_deleted" && a.messageId !== "400000000000000201");
            assert.deepEqual(gone.map(a => a.url).sort(), [signed, unsigned, media, `${cdn}1100000000000000310/new-a.png?ex=66f00000&is=66eeae80&hm=aaa&`, `${cdn}1100000000000000311/new-b.png?ex=66f00000&is=66eeae80&hm=aaa&`, `${cdn}1100000000000000312/new-c.png`].sort());
            // Asked again, nothing is left to match: the "stale camera" case of the reaction path.
            assert.equal(await removeImagesForMessages(transaction, RG, ["400000000000000300"], [unsigned], "removed_by_reaction"), 0);
        });

        test("a roll is purged by identity on the Discord CDN and exactly anywhere else", async () => {
            const stored = `${cdn}1100000000000000401/roll.png?ex=66f00000&is=66eeae80&hm=aaa&`;
            await add("homies", stored);
            await add("homies", stored, ELSEWHERE);
            await add("homies", "https://example.com/i.php?id=1");
            await add("homies", "https://example.com/i.php?id=2");

            assert.equal(await removeImageByUrl(transaction, "https://example.com/i.php", RG, "removed_by_reaction"), 0);
            assert.equal(await removeImageByUrl(transaction, "https://example.com/I.php?id=2", RG, "removed_by_reaction"), 0);
            assert.equal(await removeImageByUrl(transaction, "https://example.com/i.php?id=1", RG, "removed_by_reaction"), 1);
            assert.equal(await removeImageByUrl(transaction, `${cdn}1100000000000000401/roll.png`, RG, "removed_by_reaction"), 1);
            assert.equal(await removeImageByUrl(transaction, stored, RG, "removed_by_reaction"), 0);
            assert.ok((await live()).includes("https://example.com/i.php?id=2"));
            assert.ok((await live(ELSEWHERE)).includes(stored));
            assert.deepEqual((await archivedFor()).filter(a => a.reason === "removed_by_reaction").map(a => a.url).sort(), [stored, "https://example.com/i.php?id=1"].sort());
        });

        test("removal looks rows up through the mediaKey and messageId indexes, not by scanning", async () => {
            await query("INSERT INTO homies (url, guildId, userId, messageId) SELECT CONCAT(?, 1200000000000000000 + seq, '/filler_', seq, '.png', IF(seq % 2, '?ex=66f00000&is=66eeae80&hm=abc&', '')), ?, ?, IF(seq % 3, 1300000000000000000 + seq, NULL) FROM seq_1_to_4000", [cdn, FILLER, USER]);
            try {
                await query("ANALYZE TABLE homies");
                const plan = async (where: string, params: unknown[]) => (await query(`EXPLAIN ${archiveAndDeleteSql("homies", where).remove}`, ["homies", "message_deleted", ...params]) as any[]).find(step => step.table === "t");
                const byKey = await plan("t.guildId = ? AND t.messageId IS NULL AND t.mediaKey IN (?,?)", [FILLER, "discord:300000000000000009/1200000000000000003", "discord:300000000000000009/1200000000000000006"]);
                assert.equal(byKey.key, "homies_media_UK", `${byKey.type} on ${byKey.key}, ${byKey.rows} rows`);
                assert.ok(Number(byKey.rows) <= 4);
                const byMessage = await plan("t.guildId = ? AND t.messageId IN (?,?)", [FILLER, "1300000000000000001", "1300000000000000002"]);
                assert.equal(byMessage.key, "homies_message_IDX", `${byMessage.type} on ${byMessage.key}, ${byMessage.rows} rows`);
                assert.ok(Number(byMessage.rows) <= 4);
                assert.equal(await removeImagesForMessages(transaction, FILLER, ["1300000000000000001"], [`${cdn}1200000000000000003/filler_3.png?ex=1&is=2&hm=3&`], "message_deleted"), 2);
                assert.equal((await query("SELECT COUNT(*) AS n FROM homies WHERE guildId = ?", [FILLER]))[0].n, 3998n);
            } finally {
                await query("DELETE FROM homies WHERE guildId = ?", [FILLER]);
                await query("DELETE FROM submissions_archive WHERE guildId = ?", [FILLER]);
            }
        });
    });
});
