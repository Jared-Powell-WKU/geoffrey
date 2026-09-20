// Runs the API's real SQL against a migrated MariaDB. Skipped unless
// TEST_DB_PORT is set; project/mariadb/test-migrations.sh sets it.
import { test, describe, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as mariadb from "mariadb";
import { createInternalApi, posterKeyOf } from "../internalApi";
import { mediaKey, QueryFn, removalSql, removeImageByUrl, removeImagesForMessages, removeRows, TransactionFn } from "../util/imageRemoval";
import { createDbAccess } from "../util/dbAccess";
import { insertAttachmentsSql } from "../util/submissionSql";
import { backfillOrigins } from "../maintenance/backfillOrigins";
import { countPendingReactions, recordReactionCounts } from "../maintenance/reactionCounts";
import { FakeDiscord, GUILDS, GUILD, KEY, listen, makeRequester, MEDIA_KEY_CASES, MOD_USER, OTHER_USER, OWN_KEY_CASES, OWNER, USER } from "./helpers";

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
        for(const table of ["homies", "pets", "submissions_archive"]) await query(`DELETE FROM ${table} WHERE guildId = ?`, [GUILD]);
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

        server = createInternalApi({config: {key: KEY, guilds: GUILDS, ownerUserId: OWNER}, query, transaction, discord, log: {info: () => {}, warn: () => {}, error: console.error}});
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

    test("the pool pages through every row of the guild in the same order, and names no user id", async () => {
        const expected: any[] = await query("SELECT CAST(id AS CHAR) AS id, userId FROM homies WHERE guildId = ? ORDER BY createdAt IS NULL, createdAt DESC, id DESC", [GUILD]);
        assert.equal(expected.length, 63);
        discord.guildProfiles.set(`${GUILD}:${USER}`, {name: "Me", avatarUrl: null});
        for(const [viewer, moderator] of [[OTHER_USER, false], [MOD_USER, true], [OWNER, true]] as [string, boolean][]) {
            const seen: any[] = [];
            let cursor: string|null = null;
            do {
                const res: any = await request("GET", `/v1/guilds/${GUILD}/pool?userId=${viewer}&category=homies&limit=10` + (cursor ? `&cursor=${cursor}` : ""));
                assert.equal(res.status, 200);
                assert.equal(res.body.total, 63);
                assert.ok(!JSON.stringify(res.body).includes(USER) && !JSON.stringify(res.body).includes(OTHER_USER));
                seen.push(...res.body.items);
                cursor = res.body.nextCursor;
            } while(cursor);
            assert.deepEqual(seen.map(i => i.id), expected.map(r => r.id));
            assert.deepEqual(seen.map(i => i.mine), expected.map(r => r.userId === viewer));
            assert.deepEqual(seen.map(i => i.canDelete), expected.map(r => moderator || r.userId === viewer));
            assert.deepEqual(seen.map(i => i.poster.name), expected.map(r => r.userId === USER ? "Me" : null));
            // The two rows posted in Discord know their message; nothing else does.
            assert.deepEqual(seen.filter(i => i.messageUrl !== null).map(i => i.messageUrl), new Array(2).fill(`https://discord.com/channels/${GUILD}/300000000000000001/400000000000000001`));
        }
        assert.equal((await request("GET", `/v1/guilds/${GUILD}/pool?userId=200000000000000009&category=homies`)).body.error.code, "NOT_A_MEMBER");
    });

    test("the pool's filters narrow it to members and to a stretch of time, and the totals agree with the database", async () => {
        const keyFor = (userId: string) => posterKeyOf(KEY, GUILD, userId);
        const order = "ORDER BY createdAt IS NULL, createdAt DESC, id DESC";
        const idsOf = async (where: string, params: unknown[]) =>
            (await query(`SELECT CAST(id AS CHAR) AS id FROM homies WHERE guildId = ? AND ${where} ${order}`, [GUILD, ...params]) as any[]).map(r => r.id);
        const poolOf = (filters: string) => request("GET", `/v1/guilds/${GUILD}/pool?userId=${USER}&category=homies&limit=48&${filters}`);

        // One member, then two of them together.
        for(const userIds of [[OTHER_USER], [USER, OTHER_USER]]) {
            const expected = await idsOf(`userId IN (${userIds.map(() => "?").join(", ")})`, userIds);
            const res: any = await poolOf(`poster=${userIds.map(keyFor).join(",")}`);
            assert.equal(res.status, 200);
            assert.equal(res.body.total, expected.length);
            assert.deepEqual(res.body.items.map((i: any) => i.id), expected.slice(0, 48));
            assert.deepEqual(res.body.posters.map((p: any) => p.key), userIds.map(keyFor));
            assert.ok(!JSON.stringify(res.body).includes(USER) && !JSON.stringify(res.body).includes(OTHER_USER));
        }
        // 62 of the 63 rows have a poster; the orphan belongs to nobody.
        assert.equal((await poolOf(`poster=${[USER, OTHER_USER].map(keyFor).join(",")}`)).body.total, 62);

        // A stretch of time, paged through with the filter kept, and without
        // the rows whose date is unknown.
        const from = "2024-03-03 00:00:00", until = "2024-03-07 00:00:00";
        const inRange = await idsOf("createdAt >= ? AND createdAt < ?", [from, until]);
        assert.ok(inRange.length > 10 && inRange.length < 63);
        const seen: string[] = [];
        let cursor: string|null = null;
        do {
            const res: any = await request("GET", `/v1/guilds/${GUILD}/pool?userId=${USER}&category=homies&limit=5&from=2024-03-03T00:00:00Z&until=2024-03-07T00:00:00Z` + (cursor ? `&cursor=${cursor}` : ""));
            assert.equal(res.status, 200);
            assert.equal(res.body.total, inRange.length);
            assert.ok(res.body.items.every((i: any) => i.createdAt >= "2024-03-03T00:00:00Z" && i.createdAt < "2024-03-07T00:00:00Z"));
            seen.push(...res.body.items.map((i: any) => i.id));
            cursor = res.body.nextCursor;
        } while(cursor);
        assert.deepEqual(seen, inRange);

        // Both filters at once, and a range of one second.
        const both: any = await poolOf(`poster=${keyFor(OTHER_USER)}&from=2024-03-03T00:00:00Z&until=2024-03-07T00:00:00Z`);
        assert.deepEqual(both.body.items.map((i: any) => i.id), await idsOf("userId = ? AND createdAt >= ? AND createdAt < ?", [OTHER_USER, from, until]));
        const exact: any = await poolOf("from=2024-03-03T08:00:00Z&until=2024-03-03T08:00:01Z");
        assert.deepEqual(exact.body.items.map((i: any) => i.id), await idsOf("createdAt = ?", ["2024-03-03 08:00:00"]));
        assert.equal((await poolOf("from=2030-01-01T00:00:00Z")).body.total, 0);
    });

    test("the posters route counts the guild's members against the database", async () => {
        const counts: any[] = await query("SELECT userId, COUNT(*) AS count FROM homies WHERE guildId = ? AND userId IS NOT NULL GROUP BY userId ORDER BY COUNT(*) DESC", [GUILD]);
        const res: any = await request("GET", `/v1/guilds/${GUILD}/posters?userId=${USER}&category=homies`);
        assert.equal(res.status, 200);
        assert.equal(res.body.total, counts.length);
        assert.deepEqual(res.body.posters.map((p: any) => p.count), counts.map(r => Number(r.count)));
        assert.deepEqual(res.body.posters.map((p: any) => p.poster.key), counts.map(r => posterKeyOf(KEY, GUILD, String(r.userId))));
        assert.deepEqual(res.body.posters.map((p: any) => p.mine), counts.map(r => String(r.userId) === USER));
        assert.equal(typeof res.body.posters[0].count, "number");
        assert.ok(!JSON.stringify(res.body).includes(USER) && !JSON.stringify(res.body).includes(OTHER_USER));
        // Every key it offers narrows the pool to that member.
        for(const entry of res.body.posters) {
            const filtered: any = await request("GET", `/v1/guilds/${GUILD}/pool?userId=${USER}&category=homies&poster=${entry.poster.key}`);
            assert.equal(filtered.body.total, entry.count);
        }
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

    test("delete is for the poster, a moderator or the owner, and the reaction goes with the message's last row", async () => {
        const theirs: any[] = await query("SELECT CAST(id AS CHAR) AS id FROM homies WHERE guildId = ? AND userId = ? ORDER BY id LIMIT 3", [GUILD, OTHER_USER]);
        const orphan: any[] = await query("SELECT CAST(id AS CHAR) AS id FROM homies WHERE guildId = ? AND userId IS NULL LIMIT 1", [GUILD]);
        for(const id of [theirs[0].id, orphan[0].id]) {
            const res = await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${id}?userId=${USER}`);
            assert.equal(res.status, 403);
            assert.equal(res.body.error.code, "FORBIDDEN");
            assert.equal((await query("SELECT COUNT(*) AS n FROM homies WHERE id = ?", [id]))[0].n, 1n);
        }
        // A moderator, the owner and the poster each remove one of OTHER_USER's rows; nothing else goes.
        const before = (await query("SELECT COUNT(*) AS n FROM homies", []))[0].n;
        for(const [index, asker] of [MOD_USER, OWNER, OTHER_USER].entries()) {
            assert.deepEqual(await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${theirs[index].id}?userId=${asker}`), {status: 200, body: {deleted: true}}, asker);
            assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${theirs[index].id}?userId=${asker}`)).status, 404);
        }
        assert.equal((await query("SELECT COUNT(*) AS n FROM homies", []))[0].n, before - 3n);
        assert.equal((await query("SELECT COUNT(*) AS n FROM homies WHERE id IN (?,?,?)", theirs.map(r => r.id)))[0].n, 0n);
        // The same id in another guild is out of a moderator's and the owner's reach.
        const foreign = await query("INSERT INTO homies (url, guildId, userId) VALUES (?,?,?)", ["https://example.com/integration/foreign.png", "100000000000000555", USER]);
        for(const asker of [MOD_USER, OWNER]) assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${foreign.insertId}?userId=${asker}`)).status, 404);
        assert.equal((await query("DELETE FROM homies WHERE guildId = ?", ["100000000000000555"])).affectedRows, 1);
        const message: any[] = await query("SELECT CAST(id AS CHAR) AS id FROM homies WHERE guildId = ? AND messageId = ? ORDER BY id", [GUILD, "400000000000000001"]);
        assert.equal(message.length, 2);
        assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/pets/${message[0].id}?userId=${USER}`)).status, 404);
        assert.deepEqual(await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${message[0].id}?userId=${USER}`), {status: 200, body: {deleted: true}});
        assert.equal(discord.reactionsRemoved.length, 0);
        assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${message[1].id}?userId=${USER}`)).status, 200);
        assert.deepEqual(discord.reactionsRemoved, [{channelId: "300000000000000001", messageId: "400000000000000001"}]);
        assert.equal((await query("SELECT COUNT(*) AS n FROM homies WHERE guildId = ? AND messageId = ?", [GUILD, "400000000000000001"]))[0].n, 0n);
        assert.equal((await request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${message[1].id}?userId=${USER}`)).status, 404);
        // Removed on the site means erased: no copy is kept anywhere.
        assert.equal((await query("SELECT COUNT(*) AS n FROM submissions_archive WHERE guildId = ?", [GUILD]))[0].n, 0n);
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

    test("the origin backfill writes only its three columns, against the real schema", async () => {
        const BG = "100000000000000888";
        const channel = "300000000000000088";
        const goneChannel = "300000000000000089";
        const cdnOf = (channelId: string, n: number) => `https://cdn.discordapp.com/attachments/${channelId}/${1500000000000000000n + BigInt(n)}/old_${n}.png`;
        for(const table of ["homies", "pets"]) await query(`DELETE FROM ${table} WHERE guildId = ?`, [BG]);
        // Rows as they were before channelId and messageId existed, in both tables, plus a web row and a row that knows its message.
        for(let n = 0; n < 6; n++) await query(`INSERT INTO ${n % 2 ? "pets" : "homies"} (url, guildId, userId, createdAt) VALUES (?,?,?,?)`, [cdnOf(channel, n), BG, USER, "2023-01-01 00:00:00"]);
        for(let n = 0; n < 4; n++) await query("INSERT INTO homies (url, guildId, userId) VALUES (?,?,?)", [cdnOf(goneChannel, n), BG, USER]);
        await query("INSERT INTO homies (url, guildId, userId, createdAt, source) VALUES (?,?,?,UTC_TIMESTAMP(),'web')", ["https://example.com/integration/backfill-web.png", BG, USER]);
        await query("INSERT INTO pets (url, guildId, userId, channelId, messageId) VALUES (?,?,?,?,?)", [cdnOf(channel, 50), BG, USER, channel, "400000000000000050"]);
        const snapshot = async () => (await query("SELECT 'homies' AS t, CAST(id AS CHAR) AS id, url, guildId, userId, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') AS createdAt, source, mediaKey FROM homies WHERE guildId = ? UNION ALL SELECT 'pets', CAST(id AS CHAR), url, guildId, userId, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s'), source, mediaKey FROM pets WHERE guildId = ? ORDER BY 1, 2", [BG, BG]) as any[]).map(r => ({...r}));
        const before = await snapshot();
        assert.equal(before.length, 12);
        const totals = async () => `${(await query("SELECT COUNT(*) AS n FROM homies", []))[0].n}/${(await query("SELECT COUNT(*) AS n FROM pets", []))[0].n}/${(await query("SELECT COUNT(*) AS n FROM submissions_archive", []))[0].n}`;
        const totalsBefore = await totals();

        // Messages 0 to 3 still exist (message 1 carries attachments 1 and 2); 4 and 5 were deleted.
        const messages = [0, 1, 3].map(n => ({id: String(1500000000000000000n + BigInt(n) + 500n), attachments: (n === 1 ? [1, 2] : [n]).map(a => ({id: String(1500000000000000000n + BigInt(a))}))}));
        const fetched: string[] = [];
        const summary = await backfillOrigins({
            query,
            fetchAround: async (channelId) => {
                fetched.push(channelId);
                if(channelId === channel) return messages;
                throw Object.assign(new Error("Unknown Channel"), {code: 10003, status: 404});
            },
            sleep: async () => {}
        }, {maxLookups: 10_000, scanLimit: 100_000, intervalMs: 0});
        assert.equal(summary.stopped, null);

        const state: any[] = await query("SELECT url, channelId, messageId, originCheckedAt IS NOT NULL AS checked, TIMESTAMPDIFF(SECOND, originCheckedAt, UTC_TIMESTAMP()) AS age FROM homies WHERE guildId = ? UNION ALL SELECT url, channelId, messageId, originCheckedAt IS NOT NULL, TIMESTAMPDIFF(SECOND, originCheckedAt, UTC_TIMESTAMP()) FROM pets WHERE guildId = ?", [BG, BG]);
        const of = (url: string) => { const row = state.find(r => r.url === url); return [row.channelId, row.messageId, Number(row.checked)]; };
        assert.deepEqual(of(cdnOf(channel, 0)), [channel, messages[0].id, 1]);
        assert.deepEqual(of(cdnOf(channel, 1)), [channel, messages[1].id, 1]);
        assert.deepEqual(of(cdnOf(channel, 2)), [channel, messages[1].id, 1]);
        assert.deepEqual(of(cdnOf(channel, 3)), [channel, messages[2].id, 1]);
        assert.deepEqual(of(cdnOf(channel, 4)), [null, null, 1]);
        assert.deepEqual(of(cdnOf(channel, 5)), [null, null, 1]);
        for(let n = 0; n < 4; n++) assert.deepEqual(of(cdnOf(goneChannel, n)), [null, null, 1]);
        assert.deepEqual(of("https://example.com/integration/backfill-web.png"), [null, null, 1]);
        // The row that knew its message was not searched or stamped.
        assert.deepEqual(of(cdnOf(channel, 50)), [channel, "400000000000000050", 0]);
        // The stamp is UTC, like createdAt.
        for(const row of state.filter(r => Number(r.checked))) assert.ok(Number(row.age) >= 0 && Number(row.age) < 120, `age ${row.age}`);
        // One request settled the first four rows, two more found the deleted messages missing, one closed the other channel.
        assert.deepEqual([fetched.filter(c => c === channel).length, fetched.filter(c => c === goneChannel).length], [3, 1]);
        // No row appeared or disappeared anywhere, and no other column changed.
        assert.deepEqual(await snapshot(), before);
        assert.equal(await totals(), totalsBefore);
        // Searched once: a second run has nothing to do.
        const again = await backfillOrigins({query, fetchAround: async () => { throw new Error("nothing should be pending"); }, sleep: async () => {}}, {maxLookups: 10, scanLimit: 100_000, intervalMs: 0});
        assert.deepEqual([again.pending, again.lookups, again.stopped], [0, 0, null]);
        for(const table of ["homies", "pets"]) await query(`DELETE FROM ${table} WHERE guildId = ?`, [BG]);
    });

    test("reaction counts are written to their three columns only, and the leaderboards read them with the real SQL", async () => {
        const LG = "100000000000000999";
        const channel = "300000000000000099";
        const cdnOf = (n: number) => `https://cdn.discordapp.com/attachments/${channel}/${1600000000000000000n + BigInt(n)}/pic_${n}.png`;
        const message = (n: number) => String(1700000000000000000n + BigInt(n));
        for(const table of ["homies", "pets"]) await query(`DELETE FROM ${table} WHERE guildId = ?`, [LG]);
        // USER: message 1 with two files, message 2; OTHER_USER: message 3, message 4; a poster-less message 5;
        // a pets post 6 by MOD_USER; a web row; a row that never found its message.
        const post = (table: string, n: number, messageId: string|null, userId: string|null, createdAt: string) => query(`INSERT INTO ${table} (url, guildId, userId, channelId, messageId, createdAt) VALUES (?,?,?,?,?,?)`, [cdnOf(n), LG, userId, messageId ? channel : null, messageId, createdAt]);
        await post("homies", 1, message(1), USER, "2024-01-01 00:00:00");
        await post("homies", 2, message(1), USER, "2024-01-01 00:00:00");
        await post("homies", 3, message(2), USER, "2024-01-02 00:00:00");
        await post("homies", 4, message(3), OTHER_USER, "2024-01-03 00:00:00");
        await post("homies", 5, message(4), OTHER_USER, "2024-01-04 00:00:00");
        await post("homies", 6, message(5), null, "2024-01-05 00:00:00");
        await post("pets", 7, message(6), MOD_USER, "2024-01-06 00:00:00");
        await query("INSERT INTO homies (url, guildId, userId, createdAt, source) VALUES (?,?,?,UTC_TIMESTAMP(),'web')", ["https://example.com/integration/leaderboard-web.png", LG, USER]);
        await post("homies", 9, null, USER, "2024-01-09 00:00:00");
        const snapshot = async () => (await query("SELECT 'homies' AS t, CAST(id AS CHAR) AS id, url, guildId, userId, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') AS createdAt, source, channelId, messageId, originCheckedAt, mediaKey FROM homies WHERE guildId = ? UNION ALL SELECT 'pets', CAST(id AS CHAR), url, guildId, userId, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s'), source, channelId, messageId, originCheckedAt, mediaKey FROM pets WHERE guildId = ? ORDER BY 1, 2", [LG, LG]) as any[]).map(r => ({...r}));
        const before = await snapshot();
        assert.equal(before.length, 9);

        // An API that knows this guild, with USER and OTHER_USER as members.
        const configured = {...GUILDS, lg: {guildId: LG, adminRoleName: "Mods", channels: {homies: [channel], pets: []}}};
        const scoped = createInternalApi({config: {key: KEY, guilds: configured, ownerUserId: OWNER}, query, transaction, discord, log: {info: () => {}, warn: () => {}, error: console.error}});
        const scopedRequest = makeRequester(await listen(scoped));
        discord.members.add(`${LG}:${USER}`);
        discord.members.add(`${LG}:${OTHER_USER}`);
        discord.knownGuilds[LG] = {name: "LG", iconUrl: null};
        try {
            const boardOf = (name: string, extra = "") => scopedRequest("GET", `/v1/guilds/${LG}/leaderboard?userId=${USER}&board=${name}${extra}`);
            // Nothing is counted yet: only the submissions board has entries.
            let res = await boardOf("users-by-submissions");
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.entries.map((e: any) => [e.rank, e.score, e.mine]), [[1, 5, true], [2, 2, false], [3, 1, false]]);
            assert.deepEqual((await boardOf("users-by-reactions")).body, {board: "users-by-reactions", category: "all", entries: [], coverage: {counted: 0, total: 6}});
            assert.deepEqual((await boardOf("posts-by-reactions")).body.entries, []);

            // The job counts them: message 4 is gone, the rest have reactions.
            const reactions: Record<string, any[]> = {
                [message(1)]: [{count: 4, me: true, emoji: {name: "\u{1F4F8}"}}, {count: 2, me: false, emoji: {name: "x"}}], // 5, flashes 3
                [message(2)]: [{count: 1, me: true, emoji: {name: "\u{1F4F8}"}}],                                          // 0
                [message(3)]: [{count: 1, me: true, emoji: {name: "\u{1F4F8}"}}, {count: 7, me: false, emoji: {name: "y"}}], // 7
                [message(5)]: [{count: 3, me: false, emoji: {name: "\u{1F4F8}"}}],                                         // 3, flashes 3
                [message(6)]: [{count: 5, me: true, emoji: {name: "\u{1F4F8}"}}]                                           // 4, flashes 4
            };
            // The job reads every table, so rows other tests and the migration
            // rehearsal left behind are looked up too; only this guild's are checked.
            const fetched: string[] = [];
            const summary = await countPendingReactions({
                query,
                fetchMessage: async (channelId, messageId) => {
                    if(channelId === channel) fetched.push(messageId);
                    if(channelId !== channel || !reactions[messageId]) throw Object.assign(new Error("Unknown Message"), {code: 10008, status: 404});
                    return {id: messageId, reactions: reactions[messageId]};
                },
                sleep: async () => {}
            }, {maxLookups: 10_000, scanLimit: 100_000, intervalMs: 0});
            assert.equal(summary.stopped, null);
            assert.deepEqual(fetched.sort(), [1, 2, 3, 4, 5, 6].map(message));
            assert.ok(summary.counted >= 6 && summary.gone >= 1, JSON.stringify(summary));
            const counts: any[] = await query("SELECT messageId, reactionCount, flashCount, reactionsCheckedAt IS NOT NULL AS checked, TIMESTAMPDIFF(SECOND, reactionsCheckedAt, UTC_TIMESTAMP()) AS age FROM homies WHERE guildId = ? UNION ALL SELECT messageId, reactionCount, flashCount, reactionsCheckedAt IS NOT NULL, TIMESTAMPDIFF(SECOND, reactionsCheckedAt, UTC_TIMESTAMP()) FROM pets WHERE guildId = ?", [LG, LG]);
            const of = (messageId: string|null) => counts.filter(r => r.messageId === messageId).map(r => [r.reactionCount, r.flashCount, Number(r.checked)]);
            assert.deepEqual(of(message(1)), [[5, 3, 1], [5, 3, 1]]);
            assert.deepEqual(of(message(2)), [[0, 0, 1]]);
            assert.deepEqual(of(message(3)), [[7, 0, 1]]);
            assert.deepEqual(of(message(4)), [[null, null, 1]]);
            assert.deepEqual(of(message(5)), [[3, 3, 1]]);
            assert.deepEqual(of(message(6)), [[4, 4, 1]]);
            assert.deepEqual(of(null), [[null, null, 0], [null, null, 0]]);
            for(const row of counts.filter(r => Number(r.checked))) assert.ok(Number(row.age) >= 0 && Number(row.age) < 120, `age ${row.age}`);
            // No other column changed, and no row came or went.
            assert.deepEqual(await snapshot(), before);
            // A second run finds nothing of this guild to count.
            const again = await countPendingReactions({query, fetchMessage: async (channelId) => { assert.notEqual(channelId, channel, "nothing of this guild should be pending"); throw Object.assign(new Error("Unknown Message"), {code: 10008}); }, sleep: async () => {}}, {maxLookups: 10_000, scanLimit: 100_000, intervalMs: 0});
            assert.equal(again.stopped, null);
            assert.equal(again.counted, 0);

            // The boards, with the real window functions and sums. Scores are JSON numbers.
            // Coverage counts posts that were checked, the gone one included.
            res = await boardOf("users-by-reactions");
            assert.deepEqual(res.body.coverage, {counted: 6, total: 6});
            assert.deepEqual(res.body.entries.map((e: any) => [e.rank, e.score, e.mine]), [[1, 7, false], [2, 5, true], [3, 4, false]]);
            assert.equal(typeof res.body.entries[0].score, "number");
            res = await boardOf("posts-by-reactions");
            assert.deepEqual(res.body.entries.map((e: any) => [e.rank, e.score, e.mediaCount, e.item.url, e.item.category]), [
                [1, 7, 1, cdnOf(4), "homies"], [2, 5, 2, cdnOf(1), "homies"], [3, 4, 1, cdnOf(7), "pets"], [4, 3, 1, cdnOf(6), "homies"]
            ]);
            assert.equal(typeof res.body.entries[1].mediaCount, "number");
            assert.deepEqual([res.body.entries[1].item.mine, res.body.entries[1].item.canDelete, res.body.entries[1].item.messageUrl], [true, true, `https://discord.com/channels/${LG}/${channel}/${message(1)}`]);
            assert.deepEqual([res.body.entries[3].item.poster.name, res.body.entries[3].item.poster.avatarUrl, res.body.entries[3].item.mine, res.body.entries[3].item.canDelete], [null, null, false, false]);
            res = await boardOf("posts-by-flashes", "&category=homies&limit=2");
            assert.deepEqual(res.body.entries.map((e: any) => [e.rank, e.score, e.item.url]), [[1, 3, cdnOf(6)], [1, 3, cdnOf(1)]]);
            assert.deepEqual(res.body.coverage, {counted: 5, total: 5});
            assert.ok(!JSON.stringify(res.body).includes(USER) && !JSON.stringify(res.body).includes(OTHER_USER) && !JSON.stringify(res.body).includes(MOD_USER));

            // The recounter's write after a reaction event: the same statement, one message.
            assert.equal(await recordReactionCounts(query, LG, message(2), {reactionCount: 9, flashCount: 1}), 1);
            res = await boardOf("posts-by-reactions", "&limit=1");
            assert.deepEqual(res.body.entries.map((e: any) => [e.score, e.item.url]), [[9, cdnOf(3)]]);
            assert.deepEqual(await snapshot(), before);
        } finally {
            scoped.closeAllConnections();
            await new Promise(resolve => scoped.close(resolve));
            delete discord.knownGuilds[LG];
            for(const table of ["homies", "pets"]) await query(`DELETE FROM ${table} WHERE guildId = ?`, [LG]);
        }
    });

    describe("media identity and removal", () => {
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

        test("the bot's own judgment (the sweep) is archived as an exact copy, and leaves no copy behind when the delete fails", async () => {
            const url = `${cdn}1100000000000000201/tx.png?ex=66f00000&is=66eeae80&hm=aaa&`;
            await add("pets", url, RG, "400000000000000201");
            const [original]: any[] = await query(`SELECT ${COLUMNS} FROM pets WHERE guildId = ?`, [RG]);

            const failingDelete: TransactionFn = (work) => transaction((inTransaction) => work(async (sql, params) => {
                if(sql.startsWith("DELETE")) throw new Error("the delete failed");
                return inTransaction(sql, params);
            }));
            await assert.rejects(failingDelete((q) => removeRows(q, "pets", "gone_from_discord", "t.guildId = ?", [RG])), /the delete failed/);
            assert.deepEqual(await archivedFor(), []);
            assert.deepEqual(await live(), [url]);

            assert.equal(await transaction((q) => removeRows(q, "pets", "gone_from_discord", "t.guildId = ?", [RG])), 1);
            assert.deepEqual(await live(), []);
            assert.deepEqual(await archivedFor(), [{category: "pets", reason: "gone_from_discord", ...original}]);
            const [meta]: any[] = await query("SELECT keptId, TIMESTAMPDIFF(SECOND, archivedAt, CURRENT_TIMESTAMP) AS age FROM submissions_archive WHERE guildId = ?", [RG]);
            assert.equal(meta.keptId, null);
            assert.ok(Number(meta.age) >= 0 && Number(meta.age) < 60);
            assert.equal(await transaction((q) => removeRows(q, "pets", "gone_from_discord", "t.guildId = ?", [RG])), 0);
            await query("DELETE FROM submissions_archive WHERE guildId = ?", [RG]);
        });

        test("a removal a person asked for erases the row and keeps no copy, in one transaction", async () => {
            await add("homies", `${cdn}1100000000000000211/h.png`, RG, "400000000000000211");
            await add("pets", `${cdn}1100000000000000212/p.png`, RG, "400000000000000211");
            for(const reason of ["message_deleted", "removed_by_reaction", "removed_on_site"] as const) {
                await add("pets", `${cdn}1100000000000000213/${reason}.png`, ELSEWHERE, "400000000000000213");
                assert.equal(await transaction((q) => removeRows(q, "pets", reason, "t.guildId = ? AND t.messageId = ?", [ELSEWHERE, "400000000000000213"])), 1, reason);
            }
            assert.deepEqual(await live(ELSEWHERE), []);

            // The pets delete fails after the homies delete succeeded: the whole removal must be undone.
            const failingOnPets: TransactionFn = (work) => transaction((inTransaction) => work(async (sql, params) => {
                if(sql.startsWith("DELETE t FROM pets")) throw new Error("the delete failed");
                return inTransaction(sql, params);
            }));
            await assert.rejects(removeImagesForMessages(failingOnPets, RG, ["400000000000000211"], [], "message_deleted"), /the delete failed/);
            assert.equal((await live()).length, 2);
            assert.equal(await removeImagesForMessages(transaction, RG, ["400000000000000211"], [], "message_deleted"), 2);
            assert.deepEqual(await live(), []);
            assert.deepEqual([...(await archivedFor()), ...(await archivedFor(ELSEWHERE))], []);
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
            // Six rows are gone for good: nothing about them was archived.
            assert.deepEqual([...(await archivedFor()), ...(await archivedFor(ELSEWHERE))], []);
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
            assert.deepEqual(await archivedFor(), []);
        });

        test("removal looks rows up through the mediaKey and messageId indexes, not by scanning", async () => {
            await query("INSERT INTO homies (url, guildId, userId, messageId) SELECT CONCAT(?, 1200000000000000000 + seq, '/filler_', seq, '.png', IF(seq % 2, '?ex=66f00000&is=66eeae80&hm=abc&', '')), ?, ?, IF(seq % 3, 1300000000000000000 + seq, NULL) FROM seq_1_to_4000", [cdn, FILLER, USER]);
            try {
                await query("ANALYZE TABLE homies");
                const plan = async (where: string, params: unknown[]) => (await query(`EXPLAIN ${removalSql("homies", "message_deleted", where).remove}`, params) as any[]).find(step => step.table === "t" || step.table === "homies");
                const byKey = await plan("t.guildId = ? AND t.messageId IS NULL AND t.mediaKey IN (?,?)", [FILLER, "discord:300000000000000009/1200000000000000003", "discord:300000000000000009/1200000000000000006"]);
                assert.equal(byKey.key, "homies_media_UK", `${byKey.type} on ${byKey.key}, ${byKey.rows} rows`);
                assert.ok(Number(byKey.rows) <= 4);
                const byMessage = await plan("t.guildId = ? AND t.messageId IN (?,?)", [FILLER, "1300000000000000001", "1300000000000000002"]);
                assert.equal(byMessage.key, "homies_message_IDX", `${byMessage.type} on ${byMessage.key}, ${byMessage.rows} rows`);
                assert.ok(Number(byMessage.rows) <= 4);
                // The sweep's archived removal starts from the row, not from the archive.
                const [filler]: any[] = await query("SELECT CAST(id AS CHAR) AS id, url FROM homies WHERE guildId = ? LIMIT 1", [FILLER]);
                // An id is a unique key, so the optimizer reads that one row while planning
                // ("const tables") or plans a keyed lookup of it; either way nothing is scanned.
                const swept: any[] = await query(`EXPLAIN ${removalSql("homies", "gone_from_discord", "t.id = CAST(? AS UNSIGNED) AND t.url = ?").remove}`, ["homies", "gone_from_discord", filler.id, filler.url]);
                const sweptRow = swept.find(step => step.table === "t");
                assert.ok(sweptRow ? ["homies_id_UK", "PRIMARY"].includes(sweptRow.key) && Number(sweptRow.rows) <= 1 : /const tables/.test(String(swept[0]?.Extra)), JSON.stringify(swept, (_k, v) => typeof v === "bigint" ? Number(v) : v));
                assert.equal(await removeImagesForMessages(transaction, FILLER, ["1300000000000000001"], [`${cdn}1200000000000000003/filler_3.png?ex=1&is=2&hm=3&`], "message_deleted"), 2);
                assert.equal((await query("SELECT COUNT(*) AS n FROM homies WHERE guildId = ?", [FILLER]))[0].n, 3998n);
            } finally {
                await query("DELETE FROM homies WHERE guildId = ?", [FILLER]);
                await query("DELETE FROM submissions_archive WHERE guildId = ?", [FILLER]);
            }
        });
    });
});
