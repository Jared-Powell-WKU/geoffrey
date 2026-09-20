import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { BUSY_DELAY_MS, CAMERA_FLASH, collectedChannelsOf, countPendingReactions, countReactions, CountJobDeps, createRecounter, ERROR_DELAY_MS, FetchedMessage, formatSummary, IDLE_DELAY_MS, MAX_PENDING_RECOUNTS, nextDelay, startReactionCounts } from "../maintenance/reactionCounts";
import { FakeDb, GUILD, GUILDS, HOMIES_CHANNEL, OTHER_GUILD, USER } from "./helpers";

const PETS_CHANNEL = "300000000000000004";
const MESSAGE = "400000000000000001";
const OTHER_MESSAGE = "400000000000000002";
const reaction = (name: string, count: number, me = false) => ({count, me, emoji: {name}});

// The job's statements on top of the API's fake: what it reads, and what it
// may write, and nothing else.
class JobDb extends FakeDb {
    failOn: RegExp|null = null;
    // FakeDb's query is an instance field, already set when this one is read.
    private base = this.query;
    query = async (sql: string, params: unknown[] = []): Promise<any> => {
        this.statements.push({sql, params});
        if(this.failOn?.test(sql)) throw new Error("connection lost");
        let m: RegExpExecArray|null;
        if((m = /^SELECT guildId, channelId, messageId FROM (\w+) WHERE messageId IS NOT NULL AND channelId IS NOT NULL AND \(reactionsCheckedAt IS NULL OR reactionsCheckedAt < UTC_TIMESTAMP\(\) - INTERVAL 30 DAY\) ORDER BY reactionsCheckedAt IS NOT NULL, reactionsCheckedAt, id LIMIT \?$/.exec(sql))) {
            const stale = new Date(this.clock() - 30 * 24 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
            return this.tables[m[1]]
                .filter(r => r.messageId !== null && r.channelId !== null && (!r.reactionsCheckedAt || r.reactionsCheckedAt < stale))
                .sort((a, b) => (a.reactionsCheckedAt ? 1 : 0) - (b.reactionsCheckedAt ? 1 : 0) || String(a.reactionsCheckedAt).localeCompare(String(b.reactionsCheckedAt)) || (a.id < b.id ? -1 : 1))
                .slice(0, params[0] as number)
                .map(r => ({guildId: r.guildId, channelId: r.channelId, messageId: r.messageId}));
        }
        this.statements.pop();
        return await this.base(sql, params);
    };
}

// Message ids map to what Discord answers: a message, or an error.
function world(messages: Record<string, FetchedMessage|Error>) {
    const db = new JobDb();
    db.clock = () => Date.UTC(2026, 8, 20, 12, 0, 0);
    const calls = {fetch: [] as string[], sleep: [] as number[]};
    const deps: CountJobDeps = {
        query: (sql, params) => db.query(sql, params),
        fetchMessage: async (channelId, messageId) => {
            calls.fetch.push(`${channelId}/${messageId}`);
            const answer = messages[messageId];
            if(answer === undefined) throw Object.assign(new Error("Unknown Message"), {code: 10008});
            if(answer instanceof Error) throw answer;
            return answer;
        },
        sleep: async (ms) => { calls.sleep.push(ms); }
    };
    return {db, deps, calls};
}

describe("counting reactions", () => {
    test("every person's reaction counts once; the bot's own do not; the flash count is the camera-flash emoji only", () => {
        assert.deepEqual(countReactions([]), {reactionCount: 0, flashCount: 0});
        assert.deepEqual(countReactions(undefined), {reactionCount: 0, flashCount: 0});
        assert.deepEqual(countReactions("nope"), {reactionCount: 0, flashCount: 0});
        // The bot's camera on a post nobody reacted to.
        assert.deepEqual(countReactions([reaction(CAMERA_FLASH, 1, true)]), {reactionCount: 0, flashCount: 0});
        // Three people flashed it too, and two hearted it.
        assert.deepEqual(countReactions([reaction(CAMERA_FLASH, 4, true), reaction("❤️", 2)]), {reactionCount: 5, flashCount: 3});
        // Custom emoji have a name too; a reaction with no emoji still counts as a reaction.
        assert.deepEqual(countReactions([reaction("pepe", 7), {count: 1}, {count: 2, me: true, emoji: null}]), {reactionCount: 9, flashCount: 0});
        // Junk from a malformed answer is not a count.
        assert.deepEqual(countReactions([{count: "9", emoji: {name: CAMERA_FLASH}}, {count: -3}, {count: NaN}, {count: 2.7, me: "true"}, null]), {reactionCount: 2, flashCount: 0});
    });

    test("collected channels come from the GUILDS config, per guild", () => {
        const channels = collectedChannelsOf(GUILDS as any);
        assert.deepEqual([...channels.get(GUILD)!].sort(), [HOMIES_CHANNEL, "300000000000000002"]);
        assert.deepEqual([...channels.get(OTHER_GUILD)!].sort(), ["300000000000000003", PETS_CHANNEL]);
        assert.deepEqual(collectedChannelsOf({} as any).size, 0);
        assert.deepEqual(collectedChannelsOf({x: {guildId: 5, channels: {homies: "nope"}}} as any).size, 0);
        assert.deepEqual([...collectedChannelsOf({x: {guildId: GUILD, channels: {homies: [7, "1"]}}} as any).get(GUILD)!], ["1"]);
    });
});

describe("the recounter behind the reaction events", () => {
    function recounter(messages: Record<string, FetchedMessage|Error>, options: {delayMs?: number} = {}) {
        const {db, deps, calls} = world(messages);
        const timers: {callback: () => void, ms: number}[] = [];
        const errors: unknown[][] = [];
        const warnings: unknown[][] = [];
        const r = createRecounter({
            query: deps.query, guilds: GUILDS as any, fetchMessage: deps.fetchMessage,
            log: {info: () => {}, warn: (...args) => { warnings.push(args); }, error: (...args) => { errors.push(args); }},
            delayMs: options.delayMs,
            setTimer: (callback, ms) => { timers.push({callback, ms}); }
        });
        // Runs the due timers, then waits for the work they started.
        const fire = async () => {
            const due = timers.splice(0);
            for(const timer of due) timer.callback();
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
        };
        return {db, calls, timers, errors, warnings, fire, r};
    }

    test("a reaction on a stored post in a collected channel is one fetch, a moment later, whatever the burst", async () => {
        const {db, calls, timers, r, fire} = recounter({[MESSAGE]: {id: MESSAGE, reactions: [reaction(CAMERA_FLASH, 3, true), reaction("x", 2)]}});
        const rows = db.post("homies", {messageId: MESSAGE, files: 2});
        for(let i = 0; i < 5; i++) assert.equal(r.noticed({guildId: GUILD, channelId: HOMIES_CHANNEL, id: MESSAGE}), true);
        assert.equal(timers.length, 1);
        assert.equal(timers[0].ms, 2_000);
        assert.equal(r.pending(), 1);
        assert.equal(calls.fetch.length, 0);
        await fire();
        assert.deepEqual(calls.fetch, [`${HOMIES_CHANNEL}/${MESSAGE}`]);
        assert.equal(r.pending(), 0);
        for(const row of rows) {
            assert.equal(row.reactionCount, 4);
            assert.equal(row.flashCount, 2);
            assert.equal(row.reactionsCheckedAt, "2026-09-20 12:00:00");
        }
        // Once done, the next reaction schedules again.
        assert.equal(r.noticed({guildId: GUILD, channelId: HOMIES_CHANNEL, id: MESSAGE}), true);
        assert.equal(timers.length, 1);
    });

    test("messages the bot does not collect from, and malformed ids, are ignored without a fetch", async () => {
        const {calls, timers, r} = recounter({});
        for(const message of [
            {guildId: GUILD, channelId: "300000000000000009", id: MESSAGE},   // a chat channel of the guild
            {guildId: OTHER_GUILD, channelId: HOMIES_CHANNEL, id: MESSAGE},   // another guild's channel id
            {guildId: "999999999999999999", channelId: HOMIES_CHANNEL, id: MESSAGE},
            {guildId: null, channelId: HOMIES_CHANNEL, id: MESSAGE},          // a DM
            {guildId: GUILD, channelId: HOMIES_CHANNEL, id: "abc"},
            {guildId: GUILD, channelId: HOMIES_CHANNEL, id: undefined},
            {guildId: GUILD, channelId: 5, id: MESSAGE}
        ]) {
            assert.equal(r.noticed(message as any), false, JSON.stringify(message));
        }
        assert.equal(timers.length, 0);
        assert.equal(calls.fetch.length, 0);
    });

    test("a message with no stored rows costs a database lookup and no Discord request", async () => {
        const {db, calls, r, fire} = recounter({[MESSAGE]: {id: MESSAGE, reactions: [reaction("x", 1)]}});
        db.post("homies", {messageId: OTHER_MESSAGE});
        r.noticed({guildId: GUILD, channelId: HOMIES_CHANNEL, id: MESSAGE});
        await fire();
        assert.equal(calls.fetch.length, 0);
        assert.equal(db.statements.filter(s => s.sql.startsWith("UPDATE")).length, 0);
    });

    test("a message that is gone writes nothing and is not an error; any other failure is logged", async () => {
        const {db, errors, r, fire} = recounter({[OTHER_MESSAGE]: Object.assign(new Error("boom"), {status: 500})});
        const [gone] = db.post("homies", {messageId: MESSAGE, reactions: 5, flashes: 1});
        const [broken] = db.post("pets", {messageId: OTHER_MESSAGE, channelId: PETS_CHANNEL, reactions: 5, flashes: 1});
        r.noticed({guildId: GUILD, channelId: HOMIES_CHANNEL, id: MESSAGE});
        await fire();
        assert.equal(errors.length, 0);
        assert.equal(gone.reactionCount, 5, "the old count stays");
        assert.equal(await r.recount(GUILD, HOMIES_CHANNEL, MESSAGE), 0);
        // The pets channel of GUILD is not configured, but recount() itself trusts its caller.
        r.noticed({guildId: OTHER_GUILD, channelId: PETS_CHANNEL, id: OTHER_MESSAGE});
        await fire();
        assert.equal(errors.length, 0, "OTHER_GUILD has no such rows, so nothing was fetched");
        await assert.rejects(r.recount(GUILD, PETS_CHANNEL, OTHER_MESSAGE), /boom/);
        assert.equal(broken.reactionCount, 5);
    });

    test("a flood of distinct messages is bounded and left to the background job", async () => {
        const {warnings, timers, r} = recounter({});
        for(let i = 0; i < MAX_PENDING_RECOUNTS; i++) assert.equal(r.noticed({guildId: GUILD, channelId: HOMIES_CHANNEL, id: String(500000000000000000n + BigInt(i))}), true);
        assert.equal(r.noticed({guildId: GUILD, channelId: HOMIES_CHANNEL, id: MESSAGE}), false);
        assert.equal(warnings.length, 1);
        assert.equal(timers.length, MAX_PENDING_RECOUNTS);
    });
});

describe("the background job", () => {
    test("counts never-counted rows first, one request per message, and stamps rows whose message is gone", async () => {
        const {db, deps, calls} = world({
            [MESSAGE]: {id: MESSAGE, reactions: [reaction(CAMERA_FLASH, 2, true), reaction("y", 3)]},
            "400000000000000003": {id: "400000000000000003", reactions: []}
        });
        const twoFiles = db.post("homies", {messageId: MESSAGE, files: 2});
        const [gone] = db.post("homies", {messageId: OTHER_MESSAGE});
        const [pet] = db.post("pets", {messageId: "400000000000000003", channelId: PETS_CHANNEL});
        const [fresh] = db.post("pets", {messageId: "400000000000000004", channelId: PETS_CHANNEL, reactions: 9, flashes: 9});
        fresh.reactionsCheckedAt = "2026-09-19 00:00:00";
        db.add("homies", {url: "https://example.com/web.png", source: "web"});
        const summary = await countPendingReactions(deps);
        assert.deepEqual(summary, {pending: 4, lookups: 3, counted: 3, gone: 1, more: false, stopped: null});
        assert.deepEqual(calls.fetch, [`${HOMIES_CHANNEL}/${MESSAGE}`, `${HOMIES_CHANNEL}/${OTHER_MESSAGE}`, `${PETS_CHANNEL}/400000000000000003`]);
        assert.deepEqual(calls.sleep, [2_000, 2_000]);
        for(const row of twoFiles) assert.deepEqual([row.reactionCount, row.flashCount], [4, 1]);
        assert.deepEqual([gone.reactionCount, gone.flashCount, gone.reactionsCheckedAt], [null, null, "2026-09-20 12:00:00"]);
        assert.deepEqual([pet.reactionCount, pet.flashCount], [0, 0]);
        assert.deepEqual([fresh.reactionCount, fresh.reactionsCheckedAt], [9, "2026-09-19 00:00:00"], "a recent count is left alone");
        assert.equal(db.statements.some(s => /INSERT|DELETE/i.test(s.sql)), false);
        // A second run has nothing to do and says so.
        const again = await countPendingReactions(deps);
        assert.deepEqual(again, {pending: 0, lookups: 0, counted: 0, gone: 0, more: false, stopped: null});
        assert.equal(nextDelay(again), IDLE_DELAY_MS);
    });

    test("rows counted more than 30 days ago are counted again, oldest first, after the backlog", async () => {
        const {db, deps, calls} = world({
            [MESSAGE]: {id: MESSAGE, reactions: [reaction("x", 1)]},
            [OTHER_MESSAGE]: {id: OTHER_MESSAGE, reactions: [reaction("x", 6)]},
            "400000000000000003": {id: "400000000000000003", reactions: []}
        });
        const [older] = db.post("homies", {messageId: MESSAGE, reactions: 5});
        older.reactionsCheckedAt = "2026-07-01 00:00:00";
        const [old] = db.post("homies", {messageId: OTHER_MESSAGE, reactions: 5});
        old.reactionsCheckedAt = "2026-08-01 00:00:00";
        const [never] = db.post("homies", {messageId: "400000000000000003"});
        const summary = await countPendingReactions(deps, {maxLookups: 2, scanLimit: 500, intervalMs: 1});
        assert.deepEqual([summary.lookups, summary.counted, summary.more], [2, 2, true]);
        assert.deepEqual(calls.fetch, [`${HOMIES_CHANNEL}/400000000000000003`, `${HOMIES_CHANNEL}/${MESSAGE}`]);
        assert.equal(never.reactionCount, 0);
        assert.equal(older.reactionCount, 1);
        assert.equal(old.reactionCount, 5, "left for the next run");
        assert.equal(nextDelay(summary), BUSY_DELAY_MS);
    });

    test("a Discord failure that is not 'gone' ends the run with nothing written for that message", async () => {
        const {db, deps} = world({[MESSAGE]: Object.assign(new Error("You are being rate limited."), {status: 429})});
        const [row] = db.post("homies", {messageId: MESSAGE});
        const summary = await countPendingReactions(deps);
        assert.equal(summary.stopped, "You are being rate limited.");
        assert.equal(summary.more, true);
        assert.equal(row.reactionsCheckedAt, null);
        assert.equal(nextDelay(summary), ERROR_DELAY_MS);
        assert.match(formatSummary(summary), /stopped early: You are being rate limited/);
    });

    test("a database failure ends the run the same way", async () => {
        const {db, deps} = world({[MESSAGE]: {id: MESSAGE, reactions: []}});
        db.post("homies", {messageId: MESSAGE});
        db.failOn = /^UPDATE/;
        const summary = await countPendingReactions(deps);
        assert.equal(summary.stopped, "connection lost");
        assert.equal(summary.lookups, 1);
    });

    test("a row whose ids are not snowflakes is stamped, not sent to Discord", async () => {
        const {db, deps, calls} = world({});
        const [odd] = db.post("homies", {messageId: "keep-A"});
        const summary = await countPendingReactions(deps);
        assert.deepEqual([summary.lookups, summary.gone], [0, 1]);
        assert.equal(calls.fetch.length, 0);
        assert.equal(odd.reactionsCheckedAt, "2026-09-20 12:00:00");
    });

    test("the summary line", () => {
        assert.equal(formatSummary({pending: 12, lookups: 3, counted: 5, gone: 1, more: true, stopped: null}), "Reaction counts: 12 pending read, 3 message request(s), 5 row(s) counted, 1 message(s) gone; more remain.");
        assert.equal(formatSummary({pending: 0, lookups: 0, counted: 0, gone: 0, more: false, stopped: null}), "Reaction counts: 0 pending read, 0 message request(s), 0 row(s) counted, 0 message(s) gone; backlog done.");
    });

    test("REACTION_COUNTS=off starts nothing; otherwise the job is scheduled and can be stopped", () => {
        const logs: string[] = [];
        const log = {info: (message: string) => { logs.push(message); }, warn: () => {}, error: () => {}};
        const client: any = {isReady: () => false, rest: {get: async () => ({})}};
        assert.equal(startReactionCounts({client, query: async () => [], guilds: GUILDS as any, env: {REACTION_COUNTS: " OFF "}, log}), null);
        assert.match(logs[0], /switched off/);
        const handle = startReactionCounts({client, query: async () => [], guilds: GUILDS as any, env: {}, log});
        assert.ok(handle);
        assert.equal(handle.recounter.noticed({guildId: GUILD, channelId: HOMIES_CHANNEL, id: MESSAGE}), true);
        handle.stop();
    });
});
