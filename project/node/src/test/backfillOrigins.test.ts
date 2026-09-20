import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { backfillOrigins, BackfillOptions, BackfillDeps, BUSY_DELAY_MS, ERROR_DELAY_MS, FetchedMessage, formatSummary, IDLE_DELAY_MS, LOOKUP_LIMIT, nextDelay, startOriginBackfill } from "../maintenance/backfillOrigins";

const GUILD = "500000000000000001";
const OTHER_GUILD = "500000000000000002";
const CHANNEL = "700000000000000001";
const GONE_CHANNEL = "700000000000000002";
const EMPTY_CHANNEL = "700000000000000003";
const OTHER_GUILDS_CHANNEL = "700000000000000004";
const NOW = "2026-09-19 12:00:00";
const cdn = (attachmentId: string, channelId: string = CHANNEL) => `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/pic.png?ex=66f00000&is=66eeae80&hm=abc&`;

interface Row {
    id: bigint,
    url: string,
    guildId: string,
    source: string,
    channelId: string|null,
    messageId: string|null,
    originCheckedAt: string|null,
    userId: string|null,
    createdAt: string|null
}

// Understands exactly the statements the job issues. Anything else, a DELETE or
// an INSERT above all, fails the test as "Unexpected SQL".
class OriginDb {
    tables: Record<string, Row[]> = {homies: [], pets: []};
    statements: string[] = [];
    nextId = 1n;
    failOn: RegExp|null = null;

    add(table: string, row: Partial<Row> & {url: string}): Row {
        const full: Row = {id: this.nextId++, guildId: GUILD, source: "discord", channelId: null, messageId: null, originCheckedAt: null, userId: "600000000000000001", createdAt: "2023-04-24 10:07:17", ...row};
        this.tables[table].push(full);
        return full;
    }

    private pending(table: string): Row[] {
        if(!Object.prototype.hasOwnProperty.call(this.tables, table)) throw new Error(`Unexpected table: ${table}`);
        return this.tables[table].filter(r => r.messageId === null && r.originCheckedAt === null);
    }

    query = async (sql: string, params: unknown[] = []): Promise<any> => {
        this.statements.push(sql);
        if(this.failOn?.test(sql)) throw new Error("connection lost");
        let m: RegExpExecArray|null;
        if((m = /^SELECT CAST\(id AS CHAR\) AS id, url, guildId FROM (\w+) WHERE messageId IS NULL AND originCheckedAt IS NULL ORDER BY id LIMIT \?$/.exec(sql))) {
            return this.pending(m[1]).sort((a, b) => a.id < b.id ? -1 : 1).slice(0, params[0] as number).map(r => ({id: String(r.id), url: r.url, guildId: r.guildId}));
        }
        let hit: Row[];
        let write: (row: Row) => void = (row) => { row.originCheckedAt = NOW; };
        if((m = /^UPDATE (\w+) SET originCheckedAt = UTC_TIMESTAMP\(\) WHERE messageId IS NULL AND originCheckedAt IS NULL AND source = 'web'$/.exec(sql))) {
            hit = this.pending(m[1]).filter(r => r.source === "web");
        } else if((m = /^UPDATE (\w+) SET originCheckedAt = UTC_TIMESTAMP\(\) WHERE id = CAST\(\? AS UNSIGNED\) AND messageId IS NULL AND originCheckedAt IS NULL$/.exec(sql))) {
            hit = this.pending(m[1]).filter(r => r.id === BigInt(params[0] as string));
        } else if((m = /^UPDATE (\w+) SET originCheckedAt = UTC_TIMESTAMP\(\) WHERE messageId IS NULL AND originCheckedAt IS NULL AND mediaKey LIKE \?$/.exec(sql))) {
            const prefix = String(params[0]);
            assert.match(prefix, /^discord:[0-9]+\/%$/);
            hit = this.pending(m[1]).filter(r => r.url.includes(`/attachments/${prefix.slice("discord:".length, -1)}`));
        } else if((m = /^UPDATE (\w+) SET channelId = \?, messageId = \?, originCheckedAt = UTC_TIMESTAMP\(\) WHERE id = CAST\(\? AS UNSIGNED\) AND messageId IS NULL AND originCheckedAt IS NULL$/.exec(sql))) {
            hit = this.pending(m[1]).filter(r => r.id === BigInt(params[2] as string));
            write = (row) => { row.channelId = String(params[0]); row.messageId = String(params[1]); row.originCheckedAt = NOW; };
        } else {
            throw new Error(`Unexpected SQL: ${sql}`);
        }
        hit.forEach(write);
        return {affectedRows: hit.length};
    };
}

// A channel is the list of its messages, oldest first; a lookup returns the
// `limit` messages nearest to `around`, like Discord.
function world(channels: Record<string, FetchedMessage[]|Error>) {
    const db = new OriginDb();
    const calls = {fetch: [] as string[], sleep: [] as number[]};
    const deps: BackfillDeps = {
        query: (sql, params) => db.query(sql, params),
        fetchAround: async (channelId, around, limit) => {
            calls.fetch.push(`${channelId}/${around}/${limit}`);
            const channel = channels[channelId];
            if(channel instanceof Error) throw channel;
            if(!channel) throw Object.assign(new Error("Unknown Channel"), {code: 10003, status: 404});
            const byDistance = [...channel].sort((a, b) => {
                const da = BigInt(a.id as string) - BigInt(around), dbb = BigInt(b.id as string) - BigInt(around);
                return Number((da < 0n ? -da : da) - (dbb < 0n ? -dbb : dbb));
            });
            return byDistance.slice(0, limit);
        },
        channelGuildId: (channelId) => channelId === OTHER_GUILDS_CHANNEL ? OTHER_GUILD : channelId === CHANNEL ? GUILD : null,
        sleep: async (ms) => { calls.sleep.push(ms); }
    };
    return {db, deps, calls};
}

const OPTIONS: BackfillOptions = {maxLookups: 10, scanLimit: 500, intervalMs: 5000};
const snowflake = (n: number) => String(1100000000000000000n + BigInt(n) * 4194304000n);
// Message n carries attachment n (the message id is minted just after it).
const message = (n: number, ...extra: number[]): FetchedMessage => ({id: String(BigInt(snowflake(n)) + 1000n), attachments: [n, ...extra].map(a => ({id: snowflake(a)}))});
const stamped = (row: Row) => [row.channelId, row.messageId, row.originCheckedAt];

describe("origin backfill", () => {
    test("a match stores channelId and messageId; a miss only stamps the row", async () => {
        const {db, deps, calls} = world({[CHANNEL]: [message(1), {id: String(BigInt(snowflake(2)) + 1000n), attachments: []}, {id: "12345", attachments: [{id: snowflake(2)}]}]});
        const found = db.add("homies", {url: cdn(snowflake(1))});
        const deleted = db.add("homies", {url: cdn(snowflake(2))});
        const summary = await backfillOrigins(deps, OPTIONS);
        assert.deepEqual(stamped(found), [CHANNEL, message(1).id, NOW]);
        assert.deepEqual(stamped(deleted), [null, null, NOW]);
        assert.deepEqual(summary, {pending: 2, lookups: 2, matched: 1, notFound: 1, skipped: 0, closedChannels: 0, closedRows: 0, more: false, stopped: null});
        assert.deepEqual(calls.fetch, [`${CHANNEL}/${snowflake(1)}/${LOOKUP_LIMIT}`, `${CHANNEL}/${snowflake(2)}/${LOOKUP_LIMIT}`]);
        // Paced: a pause before every request but the first.
        assert.deepEqual(calls.sleep, [5000]);
        assert.equal(nextDelay(summary), IDLE_DELAY_MS);

        // Searched once: the next run finds nothing pending and asks Discord nothing.
        const again = await backfillOrigins(deps, OPTIONS);
        assert.deepEqual([again.pending, again.lookups], [0, 0]);
        assert.equal(calls.fetch.length, 2);
    });

    test("one request settles every pending row whose attachment it shows, across both tables", async () => {
        const messages = new Array(40).fill(0).map((_, i) => message(i));
        messages[7] = message(7, 1007, 2007);
        const {db, deps, calls} = world({[CHANNEL]: messages});
        const rows = new Array(40).fill(0).map((_, i) => db.add(i % 2 ? "pets" : "homies", {url: i % 3 ? cdn(snowflake(i)) : `https://media.discordapp.net/attachments/${CHANNEL}/${snowflake(i)}/pic.png`}));
        const second = db.add("pets", {url: cdn(snowflake(1007))});
        const third = db.add("homies", {url: cdn(snowflake(2007))});
        const summary = await backfillOrigins(deps, OPTIONS);
        assert.equal(summary.lookups, 1);
        assert.equal(summary.matched, 42);
        assert.equal(calls.fetch.length, 1);
        for(const [i, row] of rows.entries()) assert.deepEqual(stamped(row), [CHANNEL, message(i).id, NOW], String(i));
        // Several attachments of one message lead to the same message.
        assert.deepEqual([second.messageId, third.messageId], [message(7).id, message(7).id]);
    });

    test("a row that is only absent from someone else's batch stays pending for its own lookup", async () => {
        const {db, deps} = world({[CHANNEL]: [message(1), message(900000)]});
        const near = db.add("homies", {url: cdn(snowflake(1))});
        const far = db.add("homies", {url: cdn(snowflake(500000))});
        const summary = await backfillOrigins(deps, {...OPTIONS, maxLookups: 1});
        assert.deepEqual(stamped(near), [CHANNEL, message(1).id, NOW]);
        assert.deepEqual(stamped(far), [null, null, null]);
        assert.equal(summary.more, true);
        assert.equal(nextDelay(summary), BUSY_DELAY_MS);
    });

    test("Unknown Channel and Missing Access close the whole channel in one statement per table", async () => {
        const {db, deps, calls} = world({[EMPTY_CHANNEL]: Object.assign(new Error("Missing Access"), {code: 50001, status: 403}), [CHANNEL]: [message(1)]});
        const forbidden = [db.add("homies", {url: cdn(snowflake(1), EMPTY_CHANNEL)}), db.add("homies", {url: cdn(snowflake(2), EMPTY_CHANNEL)})];
        const fine = db.add("homies", {url: cdn(snowflake(1))});
        const gone = new Array(30).fill(0).map((_, i) => db.add(i % 2 ? "pets" : "homies", {url: cdn(snowflake(i), GONE_CHANNEL)}));
        const summary = await backfillOrigins(deps, {...OPTIONS, scanLimit: 10});
        assert.equal(summary.pending, 20);
        // One request per closed channel, not one per row, and the rows this run never read went too.
        assert.deepEqual(calls.fetch.map(call => call.split("/")[0]), [EMPTY_CHANNEL, CHANNEL, GONE_CHANNEL]);
        for(const row of [...gone, ...forbidden]) assert.deepEqual(stamped(row), [null, null, NOW]);
        assert.deepEqual(stamped(fine), [CHANNEL, message(1).id, NOW]);
        assert.deepEqual([summary.closedChannels, summary.closedRows, summary.matched, summary.notFound], [2, 32, 1, 0]);
        assert.equal(db.statements.filter(sql => /mediaKey LIKE/.test(sql)).length, 4);
    });

    test("a channel that returns no messages at all is closed the same way", async () => {
        const {db, deps, calls} = world({[EMPTY_CHANNEL]: []});
        const rows = [1, 2, 3].map(n => db.add("homies", {url: cdn(snowflake(n), EMPTY_CHANNEL)}));
        const summary = await backfillOrigins(deps, OPTIONS);
        assert.equal(calls.fetch.length, 1);
        for(const row of rows) assert.deepEqual(stamped(row), [null, null, NOW]);
        assert.deepEqual([summary.closedChannels, summary.closedRows], [1, 3]);
    });

    test("any other error stops the run and leaves the rows unchecked for the next one", async () => {
        for(const error of [Object.assign(new Error("Internal Server Error"), {status: 500}), Object.assign(new Error("You are being rate limited."), {status: 429}), Object.assign(new Error("Missing Permissions"), {code: 50013, status: 403}), new Error("socket hang up")]) {
            const {db, deps, calls} = world({[CHANNEL]: [message(1)], [GONE_CHANNEL]: error});
            const settled = db.add("homies", {url: cdn(snowflake(1))});
            const unlucky = [db.add("homies", {url: cdn(snowflake(2), GONE_CHANNEL)}), db.add("homies", {url: cdn(snowflake(3), GONE_CHANNEL)})];
            const never = db.add("pets", {url: cdn(snowflake(4))});
            const summary = await backfillOrigins(deps, OPTIONS);
            assert.equal(summary.stopped, error.message);
            assert.equal(summary.more, true);
            assert.equal(nextDelay(summary), ERROR_DELAY_MS);
            // What was settled before the error stays settled; nothing after it was tried.
            assert.deepEqual(stamped(settled), [CHANNEL, message(1).id, NOW]);
            for(const row of [...unlucky, never]) assert.deepEqual(stamped(row), [null, null, null]);
            assert.equal(calls.fetch.length, 2);
            assert.match(formatSummary(summary), /stopped early/);
        }
    });

    test("a database error stops the run too", async () => {
        const {db, deps, calls} = world({[CHANNEL]: [message(1)]});
        db.add("homies", {url: cdn(snowflake(1))});
        db.failOn = /^SELECT/;
        const summary = await backfillOrigins(deps, OPTIONS);
        assert.equal(summary.stopped, "connection lost");
        assert.equal(calls.fetch.length, 0);
    });

    test("rows that can have no message are stamped without asking Discord", async () => {
        const {db, deps, calls} = world({[CHANNEL]: [message(1)], [OTHER_GUILDS_CHANNEL]: [message(5)]});
        const skipped = [
            db.add("homies", {url: "https://example.com/web.png", source: "web"}),
            db.add("pets", {url: cdn(snowflake(1)), source: "web"}),
            db.add("homies", {url: "https://example.com/attachments/700000000000000001/1100000000000000000/elsewhere.png"}),
            db.add("homies", {url: "https://cdn.discordapp.com/attachments/12/34/short_ids.png"}),
            // The same picture stored for a second guild: the channel is not this guild's.
            db.add("homies", {url: cdn(snowflake(5), OTHER_GUILDS_CHANNEL), guildId: GUILD})
        ];
        const rightGuild = db.add("homies", {url: cdn(snowflake(5), OTHER_GUILDS_CHANNEL), guildId: OTHER_GUILD});
        const summary = await backfillOrigins(deps, OPTIONS);
        for(const row of skipped) assert.deepEqual(stamped(row), [null, null, NOW], row.url);
        assert.deepEqual(stamped(rightGuild), [OTHER_GUILDS_CHANNEL, message(5).id, NOW]);
        assert.equal(summary.skipped, 5);
        assert.deepEqual(calls.fetch, [`${OTHER_GUILDS_CHANNEL}/${snowflake(5)}/${LOOKUP_LIMIT}`]);
    });

    test("rows that already know their message, or were searched, are never touched", async () => {
        const {db, deps, calls} = world({[CHANNEL]: [message(1), message(2)]});
        const known = db.add("homies", {url: cdn(snowflake(1)), channelId: "1", messageId: "original"});
        const searched = db.add("homies", {url: cdn(snowflake(2)), originCheckedAt: "2026-01-01 00:00:00"});
        const summary = await backfillOrigins(deps, OPTIONS);
        assert.deepEqual(stamped(known), ["1", "original", null]);
        assert.deepEqual(stamped(searched), [null, null, "2026-01-01 00:00:00"]);
        assert.equal(summary.pending + calls.fetch.length, 0);
    });

    test("a run is bounded: so many requests, so many rows read, and only ever UPDATEs of three columns", async () => {
        // Every row in its own channel, so nothing batches.
        const channels: Record<string, FetchedMessage[]> = {};
        const channelOf = (i: number) => String(710000000000000000n + BigInt(i));
        for(let i = 0; i < 30; i++) channels[channelOf(i)] = [message(i)];
        const {db, deps, calls} = world(channels);
        for(let i = 0; i < 30; i++) db.add("homies", {url: cdn(snowflake(i), channelOf(i))});
        const before = JSON.stringify(db.tables.homies.map(({channelId, messageId, originCheckedAt, ...rest}) => ({...rest, id: String(rest.id)})));
        const summary = await backfillOrigins(deps, {maxLookups: 4, scanLimit: 10, intervalMs: 3000});
        assert.deepEqual([summary.pending, summary.lookups, summary.matched, summary.more], [10, 4, 4, true]);
        assert.deepEqual(calls.sleep, [3000, 3000, 3000]);
        assert.equal(calls.fetch.length, 4);
        // Same rows, same count, every other column untouched.
        assert.equal(JSON.stringify(db.tables.homies.map(({channelId, messageId, originCheckedAt, ...rest}) => ({...rest, id: String(rest.id)}))), before);
        assert.equal(db.tables.homies.length, 30);
        for(const sql of db.statements) {
            assert.match(sql, /^(SELECT|UPDATE (homies|pets) SET (channelId = \?, messageId = \?, )?originCheckedAt = UTC_TIMESTAMP\(\) WHERE )/);
            assert.ok(!/DELETE|INSERT|DROP|ALTER|REPLACE|TRUNCATE/i.test(sql), sql);
            if(sql.startsWith("UPDATE")) assert.ok(sql.includes("messageId IS NULL AND originCheckedAt IS NULL"), sql);
        }
    });

    test("the summary is one line without ids or URLs", () => {
        const line = formatSummary({pending: 37, lookups: 12, matched: 31, notFound: 4, skipped: 2, closedChannels: 1, closedRows: 9, more: true, stopped: null});
        assert.equal(line, "Origin backfill: 37 pending read, 12 channel request(s), 31 matched, 4 not found, 2 skipped, 1 closed channel(s) with 9 row(s); more remain.");
        assert.ok(!line.includes("\n"));
    });

    test("ORIGIN_BACKFILL=off keeps the job from starting", () => {
        const lines: unknown[][] = [];
        const log = {info: (...a: unknown[]) => { lines.push(a); }, warn: () => {}, error: () => {}};
        assert.equal(startOriginBackfill({client: {} as any, query: async () => [], env: {ORIGIN_BACKFILL: "off"}, log}), null);
        assert.equal(lines.length, 1);
        const started = startOriginBackfill({client: {} as any, query: async () => { throw new Error("must not run in this test"); }, env: {}, log});
        assert.ok(started);
        started.stop();
    });
});
