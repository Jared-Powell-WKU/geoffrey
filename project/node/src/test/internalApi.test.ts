import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { createInternalApi, createDiscordFacade, decodeCursor, encodeCursor, MAX_USER_FETCHES, messageUrlOf, parseCdnExpiry, parseOwnerUserId, rankOf, startInternalApi, validateSubmissionUrl } from "../internalApi";
import { formatWebAddNotice, getStoredUrlFromContent } from "../util/storedUrl";
import { getTableByCommandName } from "../util/tables";
import { compareNewestFirst, createHarness, FakeDb, FakeDiscord, GUILD, GUILDS, Harness, HOMIES_CHANNEL, KEY, MOD_USER, OTHER_GUILD, OTHER_USER, OWNER, USER } from "./helpers";

const STRANGER = "200000000000000009";
const list = (query: string) => `/v1/guilds/${GUILD}/submissions?${query}`;
const pool = (query: string, guildId: string = GUILD) => `/v1/guilds/${guildId}/pool?${query}`;
const remove = (id: bigint|string, userId: string, category: string = "homies", guildId: string = GUILD) => `/v1/guilds/${guildId}/submissions/${category}/${id}?userId=${userId}`;

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { await h.close(); });

describe("health and auth", () => {
    test("health needs no key and reports readiness", async () => {
        assert.deepEqual(await h.request("GET", "/v1/health", {key: null}), {status: 200, body: {status: "ok", discordReady: true}});
        h.discord.ready = false;
        assert.deepEqual((await h.request("GET", "/v1/health", {key: null})).body, {status: "ok", discordReady: false});
    });

    test("missing, malformed and wrong keys are rejected before anything else", async () => {
        const path = `/v1/users/${USER}/guilds`;
        const attempts: {key?: string|null, headers?: Record<string, string>}[] = [
            {key: null},
            {key: "x".repeat(40)},
            {key: KEY + "x"},
            {key: KEY.slice(0, -1)},
            {key: ""},
            {key: null, headers: {Authorization: `Basic ${KEY}`}},
            {key: null, headers: {Authorization: KEY}}
        ];
        for(const attempt of attempts) {
            const res = await h.request("GET", path, attempt);
            assert.equal(res.status, 401, JSON.stringify(attempt));
            assert.equal(res.body.error.code, "UNAUTHORIZED");
            assert.equal(typeof res.body.error.message, "string");
        }
        // Unknown routes do not reveal themselves to an unauthenticated caller.
        assert.equal((await h.request("GET", "/nope", {key: null})).status, 401);
        assert.equal(h.discord.memberLookups.length, 0);
        assert.equal(h.db.statements.length, 0);
    });

    test("the right key is accepted, with a case-insensitive scheme", async () => {
        assert.equal((await h.request("GET", `/v1/users/${USER}/guilds`)).status, 200);
        assert.equal((await h.request("GET", `/v1/users/${USER}/guilds`, {key: null, headers: {Authorization: `bearer ${KEY}`}})).status, 200);
    });

    test("createInternalApi refuses a short key", () => {
        const db = new FakeDb();
        const deps = {config: {key: "short", guilds: GUILDS}, query: db.query, transaction: db.transaction, discord: new FakeDiscord()};
        assert.throws(() => createInternalApi(deps), /at least 32/);
    });
});

describe("routing and readiness", () => {
    test("unknown routes and methods are 404", async () => {
        for(const [method, path] of [["GET", "/v1/nope"], ["GET", "/v2/health"], ["PUT", list(`userId=${USER}&category=homies`)], ["GET", `/v1/guilds/${GUILD}/submissions/homies/1`], ["POST", "/v1/health"], ["GET", `/v1/users/${USER}/guilds/`], ["POST", pool(`userId=${USER}&category=homies`)], ["DELETE", pool(`userId=${USER}&category=homies`)], ["GET", `/v1/guilds/${GUILD}/pool/homies?userId=${USER}`]]) {
            const res = await h.request(method, path);
            assert.equal(res.status, 404, `${method} ${path}`);
            assert.equal(res.body.error.code, "NOT_FOUND");
        }
    });

    test("503 until the Discord client is ready", async () => {
        h.discord.ready = false;
        for(const [method, path, body] of [
            ["GET", `/v1/users/${USER}/guilds`, undefined],
            ["GET", list(`userId=${USER}&category=homies`), undefined],
            ["GET", pool(`userId=${USER}&category=homies`), undefined],
            ["POST", `/v1/guilds/${GUILD}/submissions`, {userId: USER, category: "homies", url: "https://example.com/a.png"}],
            ["DELETE", `/v1/guilds/${GUILD}/submissions/homies/1?userId=${USER}`, undefined]
        ] as [string, string, unknown][]) {
            const res = await h.request(method, path, {body});
            assert.equal(res.status, 503, `${method} ${path}`);
            assert.equal(res.body.error.code, "NOT_READY");
        }
        assert.equal(h.db.statements.length, 0);
    });

    test("an unsupported guild is 404 without asking Discord", async () => {
        const res = await h.request("GET", `/v1/guilds/999999999999999999/submissions?userId=${USER}&category=homies`);
        assert.equal(res.status, 404);
        // Not for the owner either: the owner's reach is the configured guilds.
        for(const userId of [USER, OWNER]) {
            assert.equal((await h.request("GET", pool(`userId=${userId}&category=homies`, "999999999999999999"))).status, 404);
            assert.equal((await h.request("DELETE", remove(1n, userId, "homies", "999999999999999999"))).status, 404);
        }
        assert.equal(h.discord.memberLookups.length, 0);
        assert.equal(h.db.statements.length, 0);
    });

    test("unexpected failures are a generic 500 with details only in the log", async () => {
        const broken = await createHarness({query: async () => { throw new Error("secret database detail"); }});
        try {
            const res = await broken.request("GET", list(`userId=${USER}&category=homies`));
            assert.deepEqual(res, {status: 500, body: {error: {code: "INTERNAL", message: "Internal error."}}});
            assert.equal(broken.errors.length, 1);
        } finally {
            await broken.close();
        }
    });
});

describe("validation", () => {
    test("ids, category, limit, cursor and row id are validated before any SQL or Discord call", async () => {
        const bad: [string, string, unknown?][] = [
            ["GET", "/v1/users/abc/guilds"],
            ["GET", "/v1/users/1234/guilds"],
            ["GET", `/v1/users/${"1".repeat(26)}/guilds`],
            ["GET", "/v1/guilds/12x45/submissions?userId=" + USER + "&category=homies"],
            ["GET", list("category=homies")],
            ["GET", list("userId=12&category=homies")],
            ["GET", list(`userId=${USER}%27&category=homies`)],
            ["GET", list(`userId=${USER}`)],
            ["GET", list(`userId=${USER}&category=cute`)],
            ["GET", list(`userId=${USER}&category=toString`)],
            ["GET", list(`userId=${USER}&category=__proto__`)],
            ["GET", list(`userId=${USER}&category=${encodeURIComponent("homies; DROP TABLE homies")}`)],
            ["GET", list(`userId=${USER}&category=homies&limit=0`)],
            ["GET", list(`userId=${USER}&category=homies&limit=49`)],
            ["GET", list(`userId=${USER}&category=homies&limit=abc`)],
            ["GET", list(`userId=${USER}&category=homies&limit=-1`)],
            ["GET", list(`userId=${USER}&category=homies&cursor=`)],
            ["GET", list(`userId=${USER}&category=homies&cursor=!!!`)],
            ["GET", list(`userId=${USER}&category=homies&cursor=${Buffer.from('{"c":"x","i":"1"}').toString("base64url")}`)],
            ["GET", list(`userId=${USER}&category=homies&cursor=${Buffer.from('{"c":null,"i":"1 OR 1=1"}').toString("base64url")}`)],
            ["GET", "/v1/guilds/12x45/pool?userId=" + USER + "&category=homies"],
            ["GET", pool("category=homies")],
            ["GET", pool(`userId=${USER}`)],
            ["GET", pool(`userId=${USER}&category=cute`)],
            ["GET", pool(`userId=${USER}&category=homies&limit=49`)],
            ["GET", pool(`userId=${USER}&category=homies&cursor=!!!`)],
            ["DELETE", `/v1/guilds/${GUILD}/submissions/cute/1?userId=${USER}`],
            ["DELETE", `/v1/guilds/${GUILD}/submissions/homies/abc?userId=${USER}`],
            ["DELETE", `/v1/guilds/${GUILD}/submissions/homies/${"9".repeat(21)}?userId=${USER}`],
            ["DELETE", `/v1/guilds/${GUILD}/submissions/homies/1`],
            ["POST", `/v1/guilds/${GUILD}/submissions`, {category: "homies", url: "https://example.com/a.png"}],
            ["POST", `/v1/guilds/${GUILD}/submissions`, {userId: 5, category: "homies", url: "https://example.com/a.png"}],
            ["POST", `/v1/guilds/${GUILD}/submissions`, {userId: USER, category: "constructor", url: "https://example.com/a.png"}],
            ["POST", `/v1/guilds/${GUILD}/submissions`, {userId: USER, category: "homies", url: "http://example.com/a.png"}],
            ["POST", `/v1/guilds/${GUILD}/submissions`, {userId: USER, category: "homies"}],
            ["POST", `/v1/guilds/${GUILD}/submissions`, [1, 2]],
            ["POST", `/v1/guilds/${GUILD}/submissions`, "text"]
        ];
        for(const [method, path, body] of bad) {
            const res = await h.request(method, path, {body});
            assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
            assert.equal(res.body.error.code, "INVALID_REQUEST");
        }
        assert.equal(h.db.statements.length, 0);
        assert.equal(h.discord.memberLookups.length, 0);
    });

    test("a body that is not JSON is 400 and one over 8 KB is 413", async () => {
        const path = `/v1/guilds/${GUILD}/submissions`;
        assert.equal((await h.request("POST", path, {rawBody: "{nope"})).status, 400);
        assert.equal((await h.request("POST", path, {rawBody: ""})).status, 400);
        const big = JSON.stringify({userId: USER, category: "homies", url: "https://example.com/a.png", pad: "x".repeat(8200)});
        const res = await h.request("POST", path, {rawBody: big});
        assert.equal(res.status, 413);
        assert.equal(res.body.error.code, "PAYLOAD_TOO_LARGE");
        assert.equal(h.db.statements.length, 0);
    });

    test("413 also applies to a chunked body that declares no length", async () => {
        const url = new URL(h.base);
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.request({host: url.hostname, port: url.port, method: "POST", path: `/v1/guilds/${GUILD}/submissions`, headers: {Authorization: `Bearer ${KEY}`}}, res => {
                res.resume();
                resolve(res.statusCode || 0);
            });
            req.on("error", reject);
            req.write("x".repeat(5000));
            req.write("x".repeat(5000));
            req.end();
        });
        assert.equal(status, 413);
    });

    test("URL rules", () => {
        const good = [
            "https://example.com/a.png",
            "https://cdn.discordapp.com/attachments/1/2/a.png?ex=66f00000&is=66eeae80&hm=abc&",
            "https://sub.example.co.uk:8443/path/~x_(1).jpg#frag",
            "https://example.com/" + "a".repeat(1024 - "https://example.com/".length)
        ];
        for(const url of good) assert.equal(validateSubmissionUrl(url), null, url);
        const bad: unknown[] = [
            undefined, null, 5, "", "http://example.com/a.png", "HTTPS://example.com/a.png", "ftp://example.com/a",
            "https://example.com/" + "a".repeat(1025 - "https://example.com/".length),
            "https://example.com/a b.png", "https://example.com/a.png\n", "https://example.com/é.png", "https://example.com/",
            "https://user@example.com/a.png", "https://user:pw@example.com/a.png", "https://:pw@example.com/a.png",
            "https://localhost/a.png", "https://geoffrey-api/a.png", "https://[::1]/a.png", "https://example.com./a.png",
            "https:/example.com/a.png", "https://", "javascript:alert(1)"
        ];
        for(const url of bad) assert.notEqual(validateSubmissionUrl(url), null, String(url));
    });
});

describe("membership", () => {
    test("a non-member gets 403 on every guild route and no SQL runs", async () => {
        h.db.add("homies", {url: "https://example.com/1.png"});
        for(const [method, path, body] of [
            ["GET", list(`userId=${STRANGER}&category=homies`), undefined],
            ["GET", pool(`userId=${STRANGER}&category=homies`), undefined],
            ["POST", `/v1/guilds/${GUILD}/submissions`, {userId: STRANGER, category: "homies", url: "https://example.com/a.png"}],
            ["DELETE", `/v1/guilds/${GUILD}/submissions/homies/1?userId=${STRANGER}`, undefined]
        ] as [string, string, unknown][]) {
            const res = await h.request(method, path, {body});
            assert.equal(res.status, 403, `${method} ${path}`);
            assert.equal(res.body.error.code, "NOT_A_MEMBER");
        }
        assert.equal(h.db.statements.length, 0);
        assert.equal(h.db.tables.homies.length, 1);
    });

    test("membership is cached for 60 seconds per guild and user, then re-checked", async () => {
        const path = list(`userId=${USER}&category=homies`);
        await h.request("GET", path);
        await h.request("GET", path);
        assert.deepEqual(h.discord.memberLookups, [`${GUILD}:${USER}`]);
        await h.request("GET", list(`userId=${OTHER_USER}&category=homies`));
        assert.equal(h.discord.memberLookups.length, 2);

        h.discord.members.delete(`${GUILD}:${USER}`);
        h.clock.now += 59_000;
        assert.equal((await h.request("GET", path)).status, 200);
        h.clock.now += 2_000;
        assert.equal((await h.request("GET", path)).status, 403);
        assert.equal(h.discord.memberLookups.length, 3);
    });

    test("guild list holds only configured guilds the user is in", async () => {
        const mine = await h.request("GET", `/v1/users/${USER}/guilds`);
        assert.deepEqual(mine.body, {guilds: [
            {guildId: GUILD, key: "tncord", name: "TNCord", iconUrl: "https://cdn.discordapp.com/icons/100000000000000001/abc.webp?size=128", categories: ["homies"], canModerate: false},
            {guildId: OTHER_GUILD, key: "clantus", name: "Clantus", iconUrl: null, categories: ["homies", "pets"], canModerate: false}
        ]});
        assert.deepEqual((await h.request("GET", `/v1/users/${OTHER_USER}/guilds`)).body.guilds.map((g: any) => g.key), ["tncord"]);
        assert.deepEqual(await h.request("GET", `/v1/users/${STRANGER}/guilds`), {status: 200, body: {guilds: []}});
    });
});

describe("roles", () => {
    const canModerate = async (userId: string) => Object.fromEntries((await h.request("GET", `/v1/users/${userId}/guilds`)).body.guilds.map((g: any) => [g.key, g.canModerate]));

    test("canModerate is the guild's adminRoleName, by exact name, per guild", async () => {
        assert.deepEqual(await canModerate(USER), {tncord: false, clantus: false});
        assert.deepEqual(await canModerate(MOD_USER), {tncord: true});
        // The same role name in another guild is that guild's business.
        h.discord.members.add(`${OTHER_GUILD}:${MOD_USER}`);
        h.discord.roles.set(`${OTHER_GUILD}:${OTHER_USER}`, ["Mods"]);
        h.clock.now += 61_000;
        assert.deepEqual(await canModerate(MOD_USER), {tncord: true, clantus: false});
        // A role that only looks like it does not count, and a non-member's roles are never read.
        h.discord.roles.set(`${GUILD}:${OTHER_USER}`, ["mods", "Mods ", "Moderators"]);
        assert.deepEqual(await canModerate(OTHER_USER), {tncord: false});
    });

    test("a guild configured without an adminRoleName has no moderators", async () => {
        const guilds: any = {tncord: {...GUILDS.tncord, adminRoleName: ""}, clantus: {guildId: OTHER_GUILD, channels: GUILDS.clantus.channels}};
        const other = await createHarness({config: {key: KEY, guilds, ownerUserId: null}});
        try {
            other.discord.members.add(`${OTHER_GUILD}:${MOD_USER}`);
            other.discord.roles.set(`${GUILD}:${MOD_USER}`, ["", "Mods"]);
            other.discord.roles.set(`${OTHER_GUILD}:${MOD_USER}`, ["undefined", "Mods"]);
            const res = await other.request("GET", `/v1/users/${MOD_USER}/guilds`);
            assert.deepEqual(res.body.guilds.map((g: any) => [g.key, g.canModerate]), [["tncord", false], ["clantus", false]]);
        } finally {
            await other.close();
        }
    });

    test("moderator status is cached with membership for 60 seconds", async () => {
        const mod = h.db.add("homies", {url: "https://example.com/1.png", userId: OTHER_USER});
        const path = pool(`userId=${MOD_USER}&category=homies`);
        assert.equal((await h.request("GET", path)).body.items[0].canDelete, true);
        h.discord.roles.set(`${GUILD}:${MOD_USER}`, []);
        h.clock.now += 59_000;
        assert.equal((await h.request("GET", path)).body.items[0].canDelete, true);
        assert.deepEqual(h.discord.memberLookups, [`${GUILD}:${MOD_USER}`]);
        h.clock.now += 2_000;
        assert.equal((await h.request("GET", path)).body.items[0].canDelete, false);
        assert.equal((await h.request("DELETE", remove(mod.id, MOD_USER))).status, 403);
        assert.equal(h.discord.memberLookups.length, 2);
    });

    test("the owner sees every configured guild the bot is in, as a moderator, without being in any", async () => {
        assert.ok(![...h.discord.members].some(member => member.endsWith(`:${OWNER}`)));
        assert.deepEqual(await canModerate(OWNER), {tncord: true, clantus: true});
        assert.equal((await h.request("GET", pool(`userId=${OWNER}&category=homies`))).status, 200);
        assert.equal((await h.request("GET", list(`userId=${OWNER}&category=homies`))).status, 200);
        // Discord is never asked about the owner.
        assert.deepEqual(h.discord.memberLookups, []);

        // A configured guild the bot is not in is omitted, and its routes say NOT_A_MEMBER.
        delete h.discord.knownGuilds[OTHER_GUILD];
        assert.deepEqual(await canModerate(OWNER), {tncord: true});
        const res = await h.request("GET", pool(`userId=${OWNER}&category=homies`, OTHER_GUILD));
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, "NOT_A_MEMBER");
        assert.equal((await h.request("DELETE", remove(1n, OWNER, "homies", OTHER_GUILD))).body.error.code, "NOT_A_MEMBER");
    });

    test("without OWNER_USER_ID nobody is the owner", async () => {
        for(const ownerUserId of [undefined, null, "", "not-an-id", `${OWNER} `]) {
            const other = await createHarness({config: {key: KEY, guilds: GUILDS, ownerUserId}});
            try {
                assert.deepEqual((await other.request("GET", `/v1/users/${OWNER}/guilds`)).body, {guilds: []}, String(ownerUserId));
                assert.equal((await other.request("GET", pool(`userId=${OWNER}&category=homies`))).status, 403);
            } finally {
                await other.close();
            }
        }
        assert.deepEqual(parseOwnerUserId(undefined), {ownerUserId: null, invalid: false});
        assert.deepEqual(parseOwnerUserId("  "), {ownerUserId: null, invalid: false});
        assert.deepEqual(parseOwnerUserId(` ${OWNER} `), {ownerUserId: OWNER, invalid: false});
        for(const bad of ["abc", "1234", "1".repeat(26), `${OWNER},${USER}`, `<@${OWNER}>`]) assert.deepEqual(parseOwnerUserId(bad), {ownerUserId: null, invalid: true}, bad);
    });
});

describe("listing", () => {
    test("only the user's own rows in that guild and category, with JSON-safe types", async () => {
        const mine = h.db.add("homies", {url: "https://example.com/mine.png", createdAt: "2024-05-01 10:00:00"});
        h.db.add("homies", {url: "https://example.com/theirs.png", userId: OTHER_USER});
        h.db.add("homies", {url: "https://example.com/orphan.png", userId: null});
        h.db.add("homies", {url: "https://example.com/elsewhere.png", guildId: OTHER_GUILD});
        h.db.add("pets", {url: "https://example.com/pet.png"});

        const res = await h.request("GET", list(`userId=${USER}&category=homies`));
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            items: [{id: String(mine.id), category: "homies", url: mine.url, displayUrl: mine.url, createdAt: "2024-05-01T10:00:00Z", source: "discord", messageUrl: null}],
            nextCursor: null,
            total: 1
        });
        // The fake returns id and COUNT(*) as BigInt like the real driver.
        assert.equal(typeof res.body.items[0].id, "string");
        assert.equal(typeof res.body.total, "number");
        for(const {sql, params} of h.db.statements) {
            assert.match(sql, / FROM homies WHERE guildId = \? AND userId = \?/);
            assert.deepEqual(params.slice(0, 2), [GUILD, USER]);
        }
        const pets = await h.request("GET", list(`userId=${USER}&category=pets`));
        assert.deepEqual(pets.body.items.map((i: any) => i.url), ["https://example.com/pet.png"]);
        assert.ok(h.db.statements.some(s => / FROM pets /.test(s.sql)));
    });

    test("the cursor walks every row once, in a stable order, across ties and unknown dates", async () => {
        for(let i = 0; i < 130; i++) {
            let createdAt: string|null = null;
            // Ties on createdAt (every row shares a second with two others) and a block of NULLs.
            if(i % 5 !== 0) createdAt = `2024-01-${String(1 + Math.floor(i / 3) % 28).padStart(2, "0")} 00:00:${String(Math.floor(i / 3) % 60).padStart(2, "0")}`;
            h.db.add("homies", {url: `https://example.com/${i}.png`, createdAt});
            if(i % 7 === 0) h.db.add("homies", {url: `https://example.com/other-${i}.png`, userId: OTHER_USER, createdAt});
        }
        const expected = h.db.tables.homies.filter(r => r.userId === USER).sort(compareNewestFirst).map(r => String(r.id));
        assert.equal(expected.length, 130);

        for(const limit of [1, 7, 48]) {
            const seen: string[] = [];
            let cursor: string|null = null;
            let pages = 0;
            do {
                const res: any = await h.request("GET", list(`userId=${USER}&category=homies&limit=${limit}` + (cursor ? `&cursor=${cursor}` : "")));
                assert.equal(res.status, 200);
                assert.equal(res.body.total, 130);
                assert.ok(res.body.items.length <= limit);
                seen.push(...res.body.items.map((i: any) => i.id));
                cursor = res.body.nextCursor;
                assert.ok(++pages <= 131);
            } while(cursor);
            assert.deepEqual(seen, expected, `limit ${limit}`);
            assert.equal(new Set(seen).size, seen.length);
            assert.equal(pages, Math.ceil(130 / limit));
        }
        const defaults = await h.request("GET", list(`userId=${USER}&category=homies`));
        assert.equal(defaults.body.items.length, 48);
    });

    test("messageUrl links the original message when the row knows it, and is null otherwise", async () => {
        const known = h.db.add("homies", {url: "https://example.com/known.png", channelId: HOMIES_CHANNEL, messageId: "400000000000000001", createdAt: "2024-05-03 10:00:00"});
        h.db.add("homies", {url: "https://example.com/channel-only.png", channelId: HOMIES_CHANNEL, createdAt: "2024-05-02 10:00:00"});
        h.db.add("homies", {url: "https://example.com/message-only.png", messageId: "400000000000000002", createdAt: "2024-05-01 10:00:00"});
        h.db.add("homies", {url: "https://example.com/web.png", source: "web", createdAt: "2024-04-30 10:00:00"});
        h.db.add("homies", {url: "https://example.com/odd.png", channelId: "javascript:alert(1)", messageId: "400000000000000003", createdAt: "2024-04-29 10:00:00"});
        const expected = [`https://discord.com/channels/${GUILD}/${HOMIES_CHANNEL}/400000000000000001`, null, null, null, null];
        const mine = await h.request("GET", list(`userId=${USER}&category=homies`));
        assert.deepEqual(mine.body.items.map((i: any) => i.messageUrl), expected);
        assert.equal(mine.body.items[0].id, String(known.id));
        const everyone = await h.request("GET", pool(`userId=${OTHER_USER}&category=homies`));
        assert.deepEqual(everyone.body.items.map((i: any) => i.messageUrl), expected);

        assert.equal(messageUrlOf(GUILD, "300", "400000000000000001"), null);
        assert.equal(messageUrlOf(GUILD, null, null), null);
        assert.equal(messageUrlOf(GUILD, 300000000000000001, 400000000000000001), null);
    });

    test("cursor encoding round trips and rejects tampering", () => {
        assert.deepEqual(decodeCursor(encodeCursor("2024-01-02T03:04:05Z", "18446744073709551615")), {createdAt: "2024-01-02T03:04:05Z", id: "18446744073709551615"});
        assert.deepEqual(decodeCursor(encodeCursor(null, "7")), {createdAt: null, id: "7"});
        for(const raw of ["", "e30", "bnVsbA", Buffer.from('{"c":"2024-01-02 03:04:05","i":"1"}').toString("base64url"), Buffer.from('{"c":null,"i":1}').toString("base64url"), "a".repeat(300)]) {
            assert.equal(decodeCursor(raw), null, raw);
        }
    });
});

describe("pool", () => {
    const LEFT = "200000000000000005";
    const GHOST = "200000000000000006";

    function seed() {
        const rows = {
            mine: h.db.add("homies", {url: "https://example.com/mine.png", createdAt: "2024-05-05 10:00:00", channelId: HOMIES_CHANNEL, messageId: "400000000000000001"}),
            theirs: h.db.add("homies", {url: "https://example.com/theirs.png", userId: OTHER_USER, createdAt: "2024-05-04 10:00:00"}),
            mods: h.db.add("homies", {url: "https://example.com/mods.png", userId: MOD_USER, createdAt: "2024-05-03 10:00:00", source: "web"}),
            left: h.db.add("homies", {url: "https://example.com/left.png", userId: LEFT, createdAt: "2024-05-02 10:00:00"}),
            ghost: h.db.add("homies", {url: "https://example.com/ghost.png", userId: GHOST, createdAt: "2024-05-01 10:00:00"}),
            orphan: h.db.add("homies", {url: "https://example.com/orphan.png", userId: null})
        };
        h.db.add("homies", {url: "https://example.com/elsewhere.png", guildId: OTHER_GUILD});
        h.db.add("pets", {url: "https://example.com/pet.png"});
        h.discord.guildProfiles.set(`${GUILD}:${USER}`, {name: "Nick in TNCord", avatarUrl: "https://cdn.discordapp.com/guilds/1/users/2/avatars/a.webp?size=64"});
        h.discord.guildProfiles.set(`${GUILD}:${OTHER_USER}`, {name: "other", avatarUrl: null});
        h.discord.guildProfiles.set(`${GUILD}:${MOD_USER}`, {name: "A Mod", avatarUrl: "https://cdn.discordapp.com/avatars/3/b.webp?size=64"});
        h.discord.globalProfiles.set(LEFT, {name: "Gone Global", avatarUrl: "https://cdn.discordapp.com/avatars/5/c.webp?size=64"});
        return rows;
    }

    test("a member sees every row of the guild and category, with posters, mine and canDelete", async () => {
        const rows = seed();
        const res = await h.request("GET", pool(`userId=${USER}&category=homies`));
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            items: [
                {id: String(rows.mine.id), category: "homies", url: rows.mine.url, displayUrl: rows.mine.url, createdAt: "2024-05-05T10:00:00Z", source: "discord", messageUrl: `https://discord.com/channels/${GUILD}/${HOMIES_CHANNEL}/400000000000000001`,
                    poster: {name: "Nick in TNCord", avatarUrl: "https://cdn.discordapp.com/guilds/1/users/2/avatars/a.webp?size=64"}, mine: true, canDelete: true},
                {id: String(rows.theirs.id), category: "homies", url: rows.theirs.url, displayUrl: rows.theirs.url, createdAt: "2024-05-04T10:00:00Z", source: "discord", messageUrl: null,
                    poster: {name: "other", avatarUrl: null}, mine: false, canDelete: false},
                {id: String(rows.mods.id), category: "homies", url: rows.mods.url, displayUrl: rows.mods.url, createdAt: "2024-05-03T10:00:00Z", source: "web", messageUrl: null,
                    poster: {name: "A Mod", avatarUrl: "https://cdn.discordapp.com/avatars/3/b.webp?size=64"}, mine: false, canDelete: false},
                // Someone who left the guild keeps their global name; an account Discord cannot resolve has none.
                {id: String(rows.left.id), category: "homies", url: rows.left.url, displayUrl: rows.left.url, createdAt: "2024-05-02T10:00:00Z", source: "discord", messageUrl: null,
                    poster: {name: "Gone Global", avatarUrl: "https://cdn.discordapp.com/avatars/5/c.webp?size=64"}, mine: false, canDelete: false},
                {id: String(rows.ghost.id), category: "homies", url: rows.ghost.url, displayUrl: rows.ghost.url, createdAt: "2024-05-01T10:00:00Z", source: "discord", messageUrl: null,
                    poster: {name: null, avatarUrl: null}, mine: false, canDelete: false},
                {id: String(rows.orphan.id), category: "homies", url: rows.orphan.url, displayUrl: rows.orphan.url, createdAt: null, source: "discord", messageUrl: null,
                    poster: {name: null, avatarUrl: null}, mine: false, canDelete: false}
            ],
            nextCursor: null,
            total: 6
        });
        // userId is the viewer and never a filter: every statement is scoped to the guild alone.
        for(const {sql, params} of h.db.statements) {
            assert.match(sql, / FROM homies WHERE guildId = \?(?! AND userId)/);
            assert.ok(!params.includes(USER));
        }
        assert.equal((await h.request("GET", pool(`userId=${USER}&category=pets`))).body.total, 1);
    });

    test("mine and canDelete for a member, a moderator and the owner", async () => {
        seed();
        const flags = async (userId: string) => (await h.request("GET", pool(`userId=${userId}&category=homies`))).body.items.map((i: any) => `${i.mine ? "mine" : "-"}/${i.canDelete ? "del" : "-"}`);
        assert.deepEqual(await flags(OTHER_USER), ["-/-", "mine/del", "-/-", "-/-", "-/-", "-/-"]);
        assert.deepEqual(await flags(MOD_USER), ["-/del", "-/del", "mine/del", "-/del", "-/del", "-/del"]);
        assert.deepEqual(await flags(OWNER), ["-/del", "-/del", "-/del", "-/del", "-/del", "-/del"]);
        // What the pool promises, DELETE honours.
        for(const [userId, expected] of [[OTHER_USER, [403, 200, 403, 403, 403, 403]], [OWNER, [200, 200, 200, 200, 200]]] as [string, number[]][]) {
            const items = (await h.request("GET", pool(`userId=${userId}&category=homies`))).body.items;
            const statuses = [];
            for(const item of items) statuses.push((await h.request("DELETE", remove(item.id, userId))).status);
            assert.deepEqual(statuses, expected, userId);
        }
        assert.equal(h.db.tables.homies.filter(r => r.guildId === GUILD).length, 0);
    });

    test("no user id appears anywhere in a pool response", async () => {
        seed();
        for(const userId of [USER, MOD_USER, OWNER]) {
            const res = await h.request("GET", pool(`userId=${userId}&category=homies`));
            const text = JSON.stringify(res.body);
            for(const id of [USER, OTHER_USER, MOD_USER, OWNER, LEFT, GHOST]) assert.ok(!text.includes(id), `${id} leaked to ${userId}`);
            for(const item of res.body.items) {
                assert.deepEqual(Object.keys(item).sort(), ["canDelete", "category", "createdAt", "displayUrl", "id", "messageUrl", "mine", "poster", "source", "url"]);
                assert.deepEqual(Object.keys(item.poster).sort(), ["avatarUrl", "name"]);
            }
        }
        // Nor in the own listing, which reads the same columns.
        const own = await h.request("GET", list(`userId=${USER}&category=homies`));
        assert.deepEqual(Object.keys(own.body.items[0]).sort(), ["category", "createdAt", "displayUrl", "id", "messageUrl", "source", "url"]);
    });

    test("the cursor walks the whole pool once, in the listing's order, and total counts the guild", async () => {
        for(let i = 0; i < 130; i++) {
            let createdAt: string|null = null;
            if(i % 5 !== 0) createdAt = `2024-01-${String(1 + Math.floor(i / 3) % 28).padStart(2, "0")} 00:00:${String(Math.floor(i / 3) % 60).padStart(2, "0")}`;
            h.db.add("homies", {url: `https://example.com/${i}.png`, createdAt, userId: [USER, OTHER_USER, MOD_USER, null][i % 4]});
            if(i % 7 === 0) h.db.add("homies", {url: `https://example.com/elsewhere-${i}.png`, guildId: OTHER_GUILD, createdAt});
        }
        const expected = h.db.tables.homies.filter(r => r.guildId === GUILD).sort(compareNewestFirst).map(r => String(r.id));
        assert.equal(expected.length, 130);
        for(const limit of [1, 7, 48]) {
            const seen: string[] = [];
            let cursor: string|null = null;
            let pages = 0;
            do {
                const res: any = await h.request("GET", pool(`userId=${USER}&category=homies&limit=${limit}` + (cursor ? `&cursor=${cursor}` : "")));
                assert.equal(res.status, 200);
                assert.equal(res.body.total, 130);
                assert.ok(res.body.items.length <= limit);
                seen.push(...res.body.items.map((i: any) => i.id));
                cursor = res.body.nextCursor;
                assert.ok(++pages <= 131);
            } while(cursor);
            assert.deepEqual(seen, expected, `limit ${limit}`);
            assert.equal(pages, Math.ceil(130 / limit));
        }
        assert.equal((await h.request("GET", pool(`userId=${USER}&category=homies`))).body.items.length, 48);
        // The own listing still counts only the user's rows.
        assert.equal((await h.request("GET", list(`userId=${USER}&category=homies`))).body.total, 33);
    });

    test("posters are asked for once per page, distinct, and cached for ten minutes", async () => {
        seed();
        const path = pool(`userId=${USER}&category=homies`);
        await h.request("GET", path);
        assert.deepEqual(h.discord.posterLookups, [{guildId: GUILD, userIds: [USER, OTHER_USER, MOD_USER, LEFT, GHOST]}]);
        h.discord.guildProfiles.set(`${GUILD}:${OTHER_USER}`, {name: "renamed", avatarUrl: null});
        h.clock.now += 9 * 60_000;
        const cached = await h.request("GET", path);
        assert.equal(cached.body.items[1].poster.name, "other");
        assert.equal(h.discord.posterLookups.length, 1);
        h.clock.now += 61_000;
        const fresh = await h.request("GET", path);
        assert.equal(fresh.body.items[1].poster.name, "renamed");
        assert.equal(h.discord.posterLookups.length, 2);
    });

    test("a poster the facade did not get to is null now and asked about again next time", async () => {
        seed();
        h.discord.unanswered.add(LEFT);
        const path = pool(`userId=${USER}&category=homies`);
        assert.deepEqual((await h.request("GET", path)).body.items[3].poster, {name: null, avatarUrl: null});
        h.discord.unanswered.clear();
        assert.deepEqual((await h.request("GET", path)).body.items[3].poster.name, "Gone Global");
        assert.deepEqual(h.discord.posterLookups[1], {guildId: GUILD, userIds: [LEFT]});
    });

    test("failing to resolve names never fails the request, and junk from Discord is not passed on", async () => {
        seed();
        h.discord.failPosters = true;
        const path = pool(`userId=${USER}&category=homies`);
        const res = await h.request("GET", path);
        assert.equal(res.status, 200);
        assert.equal(res.body.total, 6);
        for(const item of res.body.items) assert.deepEqual(item.poster, {name: null, avatarUrl: null});
        assert.equal(h.errors.length, 1);

        h.discord.failPosters = false;
        h.discord.guildProfiles.set(`${GUILD}:${USER}`, {name: "", avatarUrl: "http://insecure.example/a.png"});
        h.discord.guildProfiles.set(`${GUILD}:${OTHER_USER}`, {name: 5, avatarUrl: {}} as any);
        const odd = await h.request("GET", path);
        assert.deepEqual(odd.body.items[0].poster, {name: null, avatarUrl: null});
        assert.deepEqual(odd.body.items[1].poster, {name: null, avatarUrl: null});
    });

    test("pool items get refreshed display URLs like the listing", async () => {
        const stored = "https://cdn.discordapp.com/attachments/1/2/a.png";
        h.db.add("homies", {url: stored, userId: OTHER_USER});
        const res = await h.request("GET", pool(`userId=${USER}&category=homies`));
        assert.match(res.body.items[0].displayUrl, /^https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/a\.png\?ex=/);
        assert.equal(res.body.items[0].url, stored);
    });
});

describe("leaderboards", () => {
    const board = (query: string, guildId: string = GUILD) => `/v1/guilds/${guildId}/leaderboard?${query}`;
    const FLASH = "\u{1F4F8}";

    // Two people's posts in GUILD, counted and not, in both tables, plus rows
    // that no board may count: no poster, another guild, added on the site.
    function seed(db: FakeDb) {
        const a = db.post("homies", {messageId: "400000000000000001", files: 2, reactions: 5, flashes: 4, createdAt: "2024-05-01 10:00:00"});
        const b = db.post("homies", {messageId: "400000000000000002", reactions: 2, flashes: 0, createdAt: "2024-05-02 10:00:00"});
        const c = db.post("homies", {messageId: "400000000000000003", userId: OTHER_USER, reactions: 10, flashes: 1, createdAt: "2024-05-03 10:00:00"});
        const d = db.post("homies", {messageId: "400000000000000004", userId: OTHER_USER, createdAt: "2024-05-04 10:00:00"}); // not counted yet
        const e = db.post("pets", {messageId: "400000000000000005", reactions: 0, flashes: 0, channelId: "300000000000000002"});
        const f = db.post("pets", {messageId: "400000000000000006", userId: MOD_USER, reactions: 10, flashes: 4, createdAt: "2024-05-06 10:00:00", channelId: "300000000000000002"});
        db.add("homies", {url: "https://example.com/web.png", source: "web", createdAt: "2024-05-07 10:00:00"});
        db.add("homies", {url: "https://example.com/nobody.png", userId: null});
        db.add("homies", {url: "https://example.com/elsewhere.png", guildId: OTHER_GUILD});
        db.add("pets", {url: "https://example.com/elsewhere-pet.png", guildId: OTHER_GUILD, userId: OTHER_USER});
        return {a, b, c, d, e, f};
    }

    test("board, category, limit and userId are validated before any SQL or Discord call", async () => {
        for(const query of [
            "userId=" + USER, "board=users-by-submissions", `userId=${USER}&board=top`, `userId=${USER}&board=`, `userId=${USER}&board=toString`,
            `userId=${USER}&board=users-by-submissions&category=cute`, `userId=${USER}&board=users-by-submissions&category=`, `userId=${USER}&board=users-by-submissions&category=ALL`,
            `userId=${USER}&board=posts-by-flashes&limit=0`, `userId=${USER}&board=posts-by-flashes&limit=101`, `userId=${USER}&board=posts-by-flashes&limit=abc`, `userId=${USER}&board=posts-by-flashes&limit=050`, `userId=${USER}&board=posts-by-flashes&limit=-1`,
            `userId=12&board=users-by-submissions`
        ]) {
            const res = await h.request("GET", board(query));
            assert.equal(res.status, 400, query);
            assert.equal(res.body.error.code, "INVALID_REQUEST");
        }
        assert.equal(h.db.statements.length, 0);
        assert.equal(h.discord.memberLookups.length, 0);
        assert.equal((await h.request("POST", board(`userId=${USER}&board=users-by-submissions`))).status, 404);
        assert.equal((await h.request("GET", board(`userId=${USER}&board=users-by-submissions`, "999999999999999999"))).status, 404);
        assert.equal((await h.request("GET", board(`userId=200000000000000009&board=users-by-submissions`))).status, 403);
        assert.equal(h.db.statements.length, 0);
        h.discord.ready = false;
        assert.equal((await h.request("GET", board(`userId=${USER}&board=users-by-submissions`))).status, 503);
    });

    test("users by submissions: one entry per poster, both tables added up, ties sharing a rank, no user id in the answer", async () => {
        seed(h.db);
        h.discord.guildProfiles.set(`${GUILD}:${USER}`, {name: "Me", avatarUrl: "https://cdn.discordapp.com/a.png"});
        h.discord.globalProfiles.set(OTHER_USER, {name: "Other", avatarUrl: null});
        const res = await h.request("GET", board(`userId=${USER}&board=users-by-submissions`));
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            board: "users-by-submissions", category: "all", coverage: null,
            entries: [
                {rank: 1, poster: {name: "Me", avatarUrl: "https://cdn.discordapp.com/a.png"}, mine: true, score: 5},
                {rank: 2, poster: {name: "Other", avatarUrl: null}, mine: false, score: 2},
                {rank: 3, poster: {name: null, avatarUrl: null}, mine: false, score: 1}
            ]
        });
        assert.ok(!JSON.stringify(res.body).includes(USER) && !JSON.stringify(res.body).includes(OTHER_USER) && !JSON.stringify(res.body).includes(MOD_USER));
        // One category, and the other person's view of it.
        const pets = await h.request("GET", board(`userId=${OTHER_USER}&board=users-by-submissions&category=pets`));
        assert.deepEqual(pets.body.entries.map((e: any) => [e.rank, e.score, e.mine]), [[1, 1, false], [1, 1, false]]);
        assert.equal(pets.body.category, "pets");
        const homies = await h.request("GET", board(`userId=${OTHER_USER}&board=users-by-submissions&category=homies&limit=1`));
        assert.deepEqual(homies.body.entries.map((e: any) => [e.rank, e.score, e.mine]), [[1, 4, false]]);
        // A tie: two more homies rows for OTHER_USER make it 4 and 4.
        h.db.post("homies", {messageId: "400000000000000009", userId: OTHER_USER, files: 2});
        const tied = await h.request("GET", board(`userId=${OTHER_USER}&board=users-by-submissions&category=homies`));
        assert.deepEqual(tied.body.entries.map((e: any) => [e.rank, e.score, e.mine]), [[1, 4, false], [1, 4, true]]);
    });

    test("users by reactions: a post's reactions count once however many files it has, uncounted posts are left out, and coverage says so", async () => {
        seed(h.db);
        const res = await h.request("GET", board(`userId=${USER}&board=users-by-reactions`));
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.entries.map((e: any) => [e.rank, e.score, e.mine]), [[1, 10, false], [1, 10, false], [3, 7, true]]);
        // Six posts have a message (a to f); d is not counted yet.
        assert.deepEqual(res.body.coverage, {counted: 5, total: 6});
        const homies = await h.request("GET", board(`userId=${USER}&board=users-by-reactions&category=homies`));
        assert.deepEqual(homies.body.entries.map((e: any) => [e.rank, e.score, e.mine]), [[1, 10, false], [2, 7, true]]);
        assert.deepEqual(homies.body.coverage, {counted: 3, total: 4});
    });

    test("posts by reactions and by flashes: one entry per post with its first file, its file count, the viewer's rights, and fresh display URLs", async () => {
        const {a, c, f} = seed(h.db);
        h.discord.guildProfiles.set(`${GUILD}:${OTHER_USER}`, {name: "Other", avatarUrl: null});
        const res = await h.request("GET", board(`userId=${USER}&board=posts-by-reactions`));
        assert.equal(res.status, 200);
        assert.equal(res.body.board, "posts-by-reactions");
        assert.deepEqual(res.body.coverage, {counted: 5, total: 6});
        assert.deepEqual(res.body.entries.map((e: any) => [e.rank, e.score, e.mediaCount, e.item.id, e.item.category]), [
            [1, 10, 1, String(f[0].id), "pets"],   // newer of the two tens first
            [1, 10, 1, String(c[0].id), "homies"],
            [3, 5, 2, String(a[0].id), "homies"],
            [4, 2, 1, "3", "homies"]
        ]);
        const first = res.body.entries[2].item;
        assert.deepEqual(first, {
            id: String(a[0].id), category: "homies", url: a[0].url,
            displayUrl: `${a[0].url.split("?")[0]}?ex=${h.discord.refreshedExpiry.toString(16)}&is=1&hm=abc&`,
            createdAt: "2024-05-01T10:00:00Z", source: "discord",
            messageUrl: `https://discord.com/channels/${GUILD}/${HOMIES_CHANNEL}/400000000000000001`,
            poster: {name: null, avatarUrl: null}, mine: true, canDelete: true
        });
        assert.deepEqual([res.body.entries[1].item.poster, res.body.entries[1].item.mine, res.body.entries[1].item.canDelete], [{name: "Other", avatarUrl: null}, false, false]);
        assert.ok(!JSON.stringify(res.body).includes(USER) && !JSON.stringify(res.body).includes(OTHER_USER));
        // A moderator may remove any of them.
        const asMod = await h.request("GET", board(`userId=${MOD_USER}&board=posts-by-reactions&limit=2`));
        assert.deepEqual(asMod.body.entries.map((e: any) => [e.item.mine, e.item.canDelete]), [[true, true], [false, true]]);
        // Flashes: the camera-flash count, posts without one left out.
        const flashes = await h.request("GET", board(`userId=${USER}&board=posts-by-flashes`));
        assert.deepEqual(flashes.body.entries.map((e: any) => [e.rank, e.score, e.item.id]), [[1, 4, String(f[0].id)], [1, 4, String(a[0].id)], [3, 1, String(c[0].id)]]);
        const petsOnly = await h.request("GET", board(`userId=${USER}&board=posts-by-flashes&category=pets`));
        assert.deepEqual(petsOnly.body.entries.map((e: any) => e.item.id), [String(f[0].id)]);
        assert.deepEqual(petsOnly.body.coverage, {counted: 2, total: 2});
        assert.equal(FLASH, "\u{1F4F8}");
    });

    test("an empty collection is an empty board", async () => {
        for(const name of ["users-by-submissions", "users-by-reactions", "posts-by-reactions", "posts-by-flashes"]) {
            const res = await h.request("GET", board(`userId=${USER}&board=${name}`));
            assert.equal(res.status, 200, name);
            assert.deepEqual(res.body.entries, []);
            assert.deepEqual(res.body.coverage, name === "users-by-submissions" ? null : {counted: 0, total: 0});
        }
        assert.equal(h.discord.refreshCalls.length, 0);
    });

    test("ranks", () => {
        assert.deepEqual(rankOf([5, 5, 3, 3, 3, 1], s => s), [1, 1, 3, 3, 3, 6]);
        assert.deepEqual(rankOf([], s => s), []);
        assert.deepEqual(rankOf([1], s => s), [1]);
    });
});

describe("adding", () => {
    const path = `/v1/guilds/${GUILD}/submissions`;
    const url = "https://i.example.com/cat.png?x=1&y=<2>";

    test("stores the URL as given, returns the row and posts the notice in the first channel", async () => {
        const res = await h.request("POST", path, {body: {userId: USER, category: "homies", url}});
        assert.equal(res.status, 201);
        // A row added on the site has no original message.
        assert.deepEqual(res.body, {item: {id: "1", category: "homies", url, displayUrl: url, createdAt: "2026-09-19T12:00:00Z", source: "web", messageUrl: null}});
        assert.deepEqual(h.db.tables.homies.map(r => [r.url, r.guildId, r.userId, r.source]), [[url, GUILD, USER, "web"]]);
        assert.deepEqual(h.discord.notices, [{channelId: HOMIES_CHANNEL, content: `<@${USER}> added an image via cantus.dev: ${url}`}]);
        // Reaction-based removal must recover exactly the stored string from that notice.
        assert.equal(getStoredUrlFromContent(h.discord.notices[0].content), url);
    });

    test("a duplicate is 409 and posts nothing", async () => {
        h.db.add("homies", {url, userId: OTHER_USER});
        const res = await h.request("POST", path, {body: {userId: USER, category: "homies", url}});
        assert.equal(res.status, 409);
        assert.equal(res.body.error.code, "DUPLICATE");
        assert.equal(h.db.tables.homies.length, 1);
        assert.equal(h.discord.notices.length, 0);
    });

    test("the same Discord attachment under another signature or host is a duplicate too", async () => {
        const stored = "https://cdn.discordapp.com/attachments/300000000000000001/1100000000000000001/pic.png";
        h.db.add("homies", {url: stored, userId: OTHER_USER});
        for(const again of [
            `${stored}?ex=66f00000&is=66eeae80&hm=abc&`,
            `${stored}?ex=77777777&is=77777000&hm=def&`,
            "https://media.discordapp.net/attachments/300000000000000001/1100000000000000001/pic.png?width=400",
            "https://cdn.discordapp.com/attachments/300000000000000001/1100000000000000001/renamed.png"
        ]) {
            const res = await h.request("POST", path, {body: {userId: USER, category: "homies", url: again}});
            assert.equal(res.status, 409, again);
            assert.equal(res.body.error.code, "DUPLICATE");
        }
        assert.equal(h.db.tables.homies.length, 1);
        assert.equal(h.discord.notices.length, 0);
        // Another attachment of the same message, and a look-alike on another host, are different pictures.
        assert.equal((await h.request("POST", path, {body: {userId: USER, category: "homies", url: "https://cdn.discordapp.com/attachments/300000000000000001/1100000000000000002/pic.png"}})).status, 201);
        assert.equal((await h.request("POST", path, {body: {userId: USER, category: "homies", url: "https://example.com/attachments/300000000000000001/1100000000000000001/pic.png"}})).status, 201);
    });

    test("the same URL is allowed in another guild", async () => {
        h.db.add("homies", {url, guildId: OTHER_GUILD});
        assert.equal((await h.request("POST", path, {body: {userId: USER, category: "homies", url}})).status, 201);
    });

    test("a failed notice is logged and does not fail the request", async () => {
        h.discord.failNotice = true;
        const res = await h.request("POST", path, {body: {userId: USER, category: "homies", url}});
        assert.equal(res.status, 201);
        assert.equal(h.errors.length, 1);
    });

    test("a category with no configured channel is refused", async () => {
        const res = await h.request("POST", path, {body: {userId: USER, category: "pets", url}});
        assert.equal(res.status, 404);
        assert.equal(h.db.tables.pets.length, 0);
    });

    test("a web-added Discord CDN URL gets a refreshed displayUrl", async () => {
        const cdn = "https://cdn.discordapp.com/attachments/1/2/a.png";
        const res = await h.request("POST", path, {body: {userId: USER, category: "homies", url: cdn}});
        assert.equal(res.body.item.url, cdn);
        assert.match(res.body.item.displayUrl, /^https:\/\/cdn\.discordapp\.com\/attachments\/1\/2\/a\.png\?ex=/);
    });
});

describe("deleting", () => {
    test("another member's row is 403 FORBIDDEN and survives; a row that is not in the guild and category is 404", async () => {
        const theirs = h.db.add("homies", {url: "https://example.com/theirs.png", userId: OTHER_USER, channelId: "1", messageId: "2"});
        const orphan = h.db.add("homies", {url: "https://example.com/orphan.png", userId: null});
        const elsewhere = h.db.add("homies", {url: "https://example.com/elsewhere.png", guildId: OTHER_GUILD});
        for(const row of [theirs, orphan]) {
            const res = await h.request("DELETE", remove(row.id, USER));
            assert.equal(res.status, 403);
            assert.equal(res.body.error.code, "FORBIDDEN");
        }
        // A row of another guild is, in this guild, an id that does not exist.
        for(const id of [elsewhere.id, 9999n]) {
            for(const userId of [USER, MOD_USER, OWNER]) {
                const res = await h.request("DELETE", remove(id, userId));
                assert.equal(res.status, 404, `${id} ${userId}`);
                assert.equal(res.body.error.code, "NOT_FOUND");
            }
        }
        assert.equal(h.db.tables.homies.length, 3);
        assert.equal(h.discord.reactionsRemoved.length, 0);
        // Nothing was even attempted.
        assert.deepEqual(h.db.transactions, []);
        assert.ok(h.db.statements.every(s => s.sql.startsWith("SELECT")));
    });

    test("a non-member cannot delete anything, not even a row stored under their id", async () => {
        const row = h.db.add("homies", {url: "https://example.com/left.png", userId: STRANGER});
        const res = await h.request("DELETE", remove(row.id, STRANGER));
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, "NOT_A_MEMBER");
        assert.equal(h.db.statements.length, 0);
        assert.equal(h.db.tables.homies.length, 1);
    });

    test("a moderator and the owner can delete anyone's row; the statement is scoped to the asker only for a plain poster", async () => {
        const byMod = h.db.add("homies", {url: "https://example.com/1.png", userId: OTHER_USER, channelId: "300000000000000001", messageId: "400000000000000001"});
        const orphan = h.db.add("homies", {url: "https://example.com/2.png", userId: null});
        const byOwner = h.db.add("homies", {url: "https://example.com/3.png", userId: OTHER_USER});
        const modsOwn = h.db.add("homies", {url: "https://example.com/4.png", userId: MOD_USER});
        const byPoster = h.db.add("homies", {url: "https://example.com/5.png", userId: OTHER_USER});
        const survivor = h.db.add("homies", {url: "https://example.com/6.png", userId: USER});

        assert.deepEqual(await h.request("DELETE", remove(byMod.id, MOD_USER)), {status: 200, body: {deleted: true}});
        assert.deepEqual(h.discord.reactionsRemoved, [{channelId: "300000000000000001", messageId: "400000000000000001"}]);
        assert.equal((await h.request("DELETE", remove(orphan.id, MOD_USER))).status, 200);
        assert.equal((await h.request("DELETE", remove(byOwner.id, OWNER))).status, 200);
        assert.equal((await h.request("DELETE", remove(modsOwn.id, MOD_USER))).status, 200);
        assert.equal((await h.request("DELETE", remove(byPoster.id, OTHER_USER))).status, 200);
        assert.deepEqual(h.db.tables.homies.map(r => r.id), [survivor.id]);

        const writes = h.db.statements.filter(s => !s.sql.startsWith("SELECT"));
        const elevated = "DELETE t FROM homies t WHERE t.id = CAST(? AS UNSIGNED) AND t.guildId = ?";
        assert.deepEqual(writes.map(s => [s.sql, s.params]), [
            [elevated, [String(byMod.id), GUILD]],
            [elevated, [String(orphan.id), GUILD]],
            [elevated, [String(byOwner.id), GUILD]],
            [elevated, [String(modsOwn.id), GUILD]],
            [`${elevated} AND t.userId = ?`, [String(byPoster.id), GUILD, OTHER_USER]]
        ]);
        // Whoever asked, it is a person's decision: erased in a transaction, no archive copy.
        assert.deepEqual(h.db.transactions, new Array(5).fill(["begin", "commit"]).flat());
        assert.ok(!h.db.statements.some(s => /submissions_archive|INSERT/i.test(s.sql)));
    });

    test("a moderator of one guild is nobody special in another", async () => {
        h.discord.members.add(`${OTHER_GUILD}:${MOD_USER}`);
        const row = h.db.add("homies", {url: "https://example.com/clantus.png", guildId: OTHER_GUILD, userId: USER});
        const res = await h.request("DELETE", remove(row.id, MOD_USER, "homies", OTHER_GUILD));
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, "FORBIDDEN");
        assert.equal(h.db.tables.homies.length, 1);
    });

    test("a row that vanishes between the lookup and the delete is 404", async () => {
        const row = h.db.add("homies", {url: "https://example.com/1.png", channelId: "300000000000000001", messageId: "400000000000000001"});
        const real = h.db.query;
        const racing = await createHarness({transaction: h.db.transaction, query: async (sql: string, params: unknown[] = []) => {
            const result = await real(sql, params);
            if(sql.startsWith("SELECT userId, channelId, messageId")) h.db.tables.homies = [];
            return result;
        }});
        try {
            const res = await racing.request("DELETE", remove(row.id, USER));
            assert.equal(res.status, 404);
            assert.equal(racing.discord.reactionsRemoved.length, 0);
        } finally {
            await racing.close();
        }
    });

    test("ids are per category", async () => {
        const row = h.db.add("homies", {url: "https://example.com/mine.png"});
        assert.equal((await h.request("DELETE", `/v1/guilds/${GUILD}/submissions/pets/${row.id}?userId=${USER}`)).status, 404);
        assert.equal(h.db.tables.homies.length, 1);
    });

    test("the poster can delete, and the camera reaction goes with the last row of a message", async () => {
        const first = h.db.add("homies", {url: "https://example.com/1.png", channelId: "300", messageId: "400"});
        const second = h.db.add("homies", {url: "https://example.com/2.png", channelId: "300", messageId: "400"});
        const web = h.db.add("homies", {url: "https://example.com/3.png", source: "web"});

        assert.deepEqual(await h.request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${first.id}?userId=${USER}`), {status: 200, body: {deleted: true}});
        assert.equal(h.discord.reactionsRemoved.length, 0);
        assert.equal((await h.request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${second.id}?userId=${USER}`)).status, 200);
        assert.deepEqual(h.discord.reactionsRemoved, [{channelId: "300", messageId: "400"}]);
        assert.equal((await h.request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${web.id}?userId=${USER}`)).status, 200);
        assert.equal(h.discord.reactionsRemoved.length, 1);
        assert.equal(h.db.tables.homies.length, 0);
        assert.equal((await h.request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${web.id}?userId=${USER}`)).status, 404);
        // The user asked for it, so the row is erased: a plain delete in a transaction, and no archive copy.
        assert.deepEqual(h.db.transactions, ["begin", "commit", "begin", "commit", "begin", "commit"]);
        const writes = h.db.statements.filter(s => !s.sql.startsWith("SELECT"));
        // The fourth request found no row and never reached the delete.
        assert.deepEqual(h.db.transactions.length, 6);
        assert.deepEqual(writes.map(s => s.sql), new Array(3).fill("DELETE t FROM homies t WHERE t.id = CAST(? AS UNSIGNED) AND t.guildId = ? AND t.userId = ?"));
        assert.deepEqual(writes[0].params, [String(first.id), GUILD, USER]);
        assert.ok(!h.db.statements.some(s => /submissions_archive/i.test(s.sql)));
    });

    test("a delete that fails is rolled back and reported, and the camera stays", async () => {
        const row = h.db.add("homies", {url: "https://example.com/1.png", channelId: "300", messageId: "400"});
        const real = h.db.query;
        h.db.query = async (sql: string, params: unknown[] = []) => {
            if(sql.startsWith("DELETE t FROM")) throw new Error("lock wait timeout");
            return real(sql, params);
        };
        const failing = await createHarness({query: h.db.query, transaction: h.db.transaction});
        try {
            const res = await failing.request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${row.id}?userId=${USER}`);
            assert.equal(res.status, 500);
            assert.equal(h.db.tables.homies.length, 1);
            assert.equal(h.db.transactions.join(), "begin,rollback");
            assert.equal(failing.discord.reactionsRemoved.length, 0);
        } finally {
            await failing.close();
        }
    });
});

describe("display URLs", () => {
    test("expiry parsing", () => {
        assert.equal(parseCdnExpiry("https://cdn.discordapp.com/attachments/1/2/a.png?ex=66f00000&is=66eeae80&hm=abc&"), 0x66f00000 * 1000);
        assert.equal(parseCdnExpiry("https://cdn.discordapp.com/attachments/1/2/a.png?EX=1"), null);
        assert.equal(parseCdnExpiry("https://cdn.discordapp.com/attachments/1/2/a.png"), null);
        assert.equal(parseCdnExpiry("https://cdn.discordapp.com/attachments/1/2/a.png?ex=zz&is=1&hm=2"), null);
        assert.equal(parseCdnExpiry("https://cdn.discordapp.com/attachments/1/2/a.png?ex=66f00000"), null);
        assert.equal(parseCdnExpiry("not a url"), null);
    });

    test("only stale Discord CDN URLs are refreshed, and results are cached until 5 minutes before ex", async () => {
        const nowSeconds = Math.floor(h.clock.now / 1000);
        const unsigned = "https://cdn.discordapp.com/attachments/1/2/unsigned.png";
        const expired = `https://media.discordapp.net/attachments/1/3/expired.png?ex=${(nowSeconds - 10).toString(16)}&is=1&hm=abc&`;
        const fresh = `https://cdn.discordapp.com/attachments/1/4/fresh.png?ex=${(nowSeconds + 3600).toString(16)}&is=1&hm=abc&`;
        const foreign = "https://example.com/attachments/1/5/foreign.png";
        const lookalike = "https://cdn.discordapp.com.example.com/attachments/1/6/a.png";
        for(const url of [unsigned, expired, fresh, foreign, lookalike]) h.db.add("homies", {url});
        h.discord.refreshedExpiry = nowSeconds + 1000;

        const path = list(`userId=${USER}&category=homies`);
        const first = await h.request("GET", path);
        const byUrl = (body: any) => Object.fromEntries(body.items.map((i: any) => [i.url, i.displayUrl]));
        assert.deepEqual(h.discord.refreshCalls.map(c => [...c].sort()), [[unsigned, expired].sort()]);
        const shown = byUrl(first.body);
        assert.equal(shown[unsigned], `${unsigned}?ex=${(nowSeconds + 1000).toString(16)}&is=1&hm=abc&`);
        assert.match(shown[expired], /expired\.png\?ex=/);
        assert.notEqual(shown[expired], expired);
        assert.equal(shown[fresh], fresh);
        assert.equal(shown[foreign], foreign);
        assert.equal(shown[lookalike], lookalike);

        // Still inside ex - 5 min: served from the cache.
        h.clock.now += (1000 - 300 - 1) * 1000;
        assert.deepEqual(byUrl((await h.request("GET", path)).body), shown);
        assert.equal(h.discord.refreshCalls.length, 1);
        // Past ex - 5 min: refreshed again.
        h.clock.now += 2000;
        h.discord.refreshedExpiry = nowSeconds + 90_000;
        await h.request("GET", path);
        assert.equal(h.discord.refreshCalls.length, 2);
    });

    test("a failed refresh falls back to the stored URL", async () => {
        const stored = "https://cdn.discordapp.com/attachments/1/2/a.png";
        h.db.add("homies", {url: stored});
        h.discord.failRefresh = true;
        const res = await h.request("GET", list(`userId=${USER}&category=homies`));
        assert.equal(res.status, 200);
        assert.equal(res.body.items[0].displayUrl, stored);
        assert.equal(h.errors.length, 1);
    });
});

describe("startInternalApi", () => {
    const fakeClient: any = {isReady: () => false};
    const recorder = () => {
        const lines: Record<string, unknown[][]> = {info: [], warn: [], error: []};
        return {lines, log: {info: (...a: unknown[]) => { lines.info.push(a); }, warn: (...a: unknown[]) => { lines.warn.push(a); }, error: (...a: unknown[]) => { lines.error.push(a); }}};
    };

    test("stays off, with one warning, when the key is unset or short", () => {
        for(const env of [{}, {INTERNAL_API_KEY: ""}, {INTERNAL_API_KEY: "x".repeat(31)}] as NodeJS.ProcessEnv[]) {
            const {lines, log} = recorder();
            assert.equal(startInternalApi({client: fakeClient, query: async () => [], transaction: new FakeDb().transaction, env, log}), null);
            assert.equal(lines.warn.length, 1);
            assert.equal(lines.error.length, 0);
            assert.ok(!JSON.stringify(lines.warn).includes("x".repeat(31)));
        }
    });

    test("an invalid OWNER_USER_ID is one warning, and the API still starts", async () => {
        for(const [value, warnings] of [["not-an-id", 1], ["", 0], [OWNER, 0]] as [string, number][]) {
            const probe = net.createServer();
            await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
            const port = (probe.address() as net.AddressInfo).port;
            await new Promise(resolve => probe.close(resolve));
            const {lines, log} = recorder();
            const server = startInternalApi({client: fakeClient, query: async () => [], transaction: new FakeDb().transaction, env: {INTERNAL_API_KEY: KEY, INTERNAL_API_PORT: String(port), GUILDS: JSON.stringify(GUILDS), OWNER_USER_ID: value}, log});
            assert.ok(server);
            if(!server.listening) await new Promise(resolve => server.once("listening", resolve));
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            assert.equal(lines.warn.filter(line => /OWNER_USER_ID/.test(String(line[0]))).length, warnings, value);
        }
    });

    test("listens on INTERNAL_API_PORT when the key is long enough", async () => {
        const probe = net.createServer();
        await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
        const port = (probe.address() as net.AddressInfo).port;
        await new Promise(resolve => probe.close(resolve));

        const {lines, log} = recorder();
        const server = startInternalApi({client: fakeClient, query: async () => [], transaction: new FakeDb().transaction, env: {INTERNAL_API_KEY: KEY, INTERNAL_API_PORT: String(port), GUILDS: JSON.stringify(GUILDS)}, log});
        assert.ok(server);
        try {
            if(!server.listening) await new Promise(resolve => server.once("listening", resolve));
            const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
            assert.deepEqual(await res.json(), {status: "ok", discordReady: false});
            assert.equal((await fetch(`http://127.0.0.1:${port}/v1/users/${USER}/guilds`)).status, 401);
            assert.equal(lines.warn.length, 0);
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
});

describe("Discord facade", () => {
    function fakeClient(fetchMember: (options: any) => Promise<unknown>) {
        const calls: any[] = [];
        const sent: any[] = [];
        const client: any = {
            isReady: () => true,
            guilds: {cache: new Map([[GUILD, {name: "TNCord", iconURL: () => null, members: {fetch: (options: any) => { calls.push(options); return fetchMember(options); }}}]])},
            channels: {fetch: async (id: string) => id === "1" ? {isSendable: () => true, send: async (message: any) => { sent.push(message); }} : {isSendable: () => false}},
            rest: {
                post: async (route: string, options: any) => { calls.push({route, options}); return {refreshed_urls: [{original: "a", refreshed: "b"}]}; },
                delete: async (route: string) => { calls.push({route}); }
            }
        };
        return {client, calls, sent};
    }

    const member = (...roleNames: string[]) => ({roles: {cache: roleNames.map(name => ({name}))}});

    test("Unknown Member and Unknown User mean not a member; other errors propagate", async () => {
        for(const code of [10007, 10013]) {
            const {client} = fakeClient(async () => { throw Object.assign(new Error("Unknown"), {code}); });
            assert.equal(await createDiscordFacade(client).memberRoles(GUILD, USER), null);
        }
        const {client: failing} = fakeClient(async () => { throw Object.assign(new Error("Server error"), {code: 0, status: 500}); });
        await assert.rejects(createDiscordFacade(failing).memberRoles(GUILD, USER), /Server error/);

        const {client, calls} = fakeClient(async () => member("@everyone", "Mods"));
        assert.deepEqual(await createDiscordFacade(client).memberRoles(GUILD, USER), ["@everyone", "Mods"]);
        // The member cache is never invalidated without the GuildMembers intent.
        assert.deepEqual(calls, [{user: USER, force: true, cache: false}]);
        assert.equal(await createDiscordFacade(client).memberRoles("999999999999999999", USER), null);
        const {client: roleless} = fakeClient(async () => member());
        assert.deepEqual(await createDiscordFacade(roleless).memberRoles(GUILD, USER), []);
    });

    describe("posters", () => {
        const IDS = new Array(14).fill(0).map((_, i) => `2100000000000000${String(i).padStart(2, "0")}`);
        const guildMember = (id: string, nick: string, guildAvatar: string|null, userAvatar: string|null) => ({
            id, displayName: nick, avatarURL: (options: any) => guildAvatar && `${guildAvatar}?size=${options.size}`,
            user: {avatarURL: (options: any) => userAvatar && `${userAvatar}?size=${options.size}`}
        });

        // The facade reports what it could not look up on the console.
        async function quietly<T>(work: () => Promise<T>): Promise<T> {
            const original = console.error;
            console.error = () => {};
            try {
                return await work();
            } finally {
                console.error = original;
            }
        }

        function posterClient(inGuild: any[], users: Record<string, any>, options: {failChunk?: boolean} = {}) {
            const memberCache = new Map<string, unknown>([[IDS[0], "cached before"]]);
            const calls = {chunks: [] as any[], users: [] as any[]};
            const client: any = {
                isReady: () => true,
                guilds: {cache: new Map([[GUILD, {members: {cache: memberCache, fetch: async (request: any) => {
                    calls.chunks.push(request);
                    if(options.failChunk) throw new Error("GuildMembersTimeout");
                    // Like discord.js: whatever a chunk brings is put in the member cache.
                    const found = inGuild.filter(m => request.user.includes(m.id));
                    for(const m of found) memberCache.set(m.id, m);
                    return new Map(found.map(m => [m.id, m]));
                }}}]])},
                users: {fetch: async (id: string, fetchOptions: any) => {
                    calls.users.push([id, fetchOptions]);
                    if(users[id] instanceof Error) throw users[id];
                    if(!users[id]) throw Object.assign(new Error("Unknown User"), {code: 10013});
                    return users[id];
                }}
            };
            return {client, calls, memberCache};
        }

        test("one member request for the page, then a bounded number of user fetches for those who left", async () => {
            const {client, calls, memberCache} = posterClient(
                [guildMember(IDS[0], "Nick", "https://cdn.discordapp.com/guilds/1/users/0/avatars/g.webp", "https://cdn.discordapp.com/avatars/0/u.webp"), guildMember(IDS[1], "plain", null, "https://cdn.discordapp.com/avatars/1/u.webp"), guildMember(IDS[2], "bare", null, null)],
                {[IDS[3]]: {displayName: "Left Long Ago", avatarURL: () => null}, [IDS[5]]: Object.assign(new Error("Server error"), {status: 500})}
            );
            const posters = await quietly(() => createDiscordFacade(client).resolvePosters(GUILD, IDS));
            assert.deepEqual(calls.chunks, [{user: IDS, time: 5000}]);
            assert.deepEqual(posters.get(IDS[0]), {name: "Nick", avatarUrl: "https://cdn.discordapp.com/guilds/1/users/0/avatars/g.webp?size=64"});
            assert.deepEqual(posters.get(IDS[1]), {name: "plain", avatarUrl: "https://cdn.discordapp.com/avatars/1/u.webp?size=64"});
            assert.deepEqual(posters.get(IDS[2]), {name: "bare", avatarUrl: null});
            assert.deepEqual(posters.get(IDS[3]), {name: "Left Long Ago", avatarUrl: null});
            // Unknown User is an answer; a server error is not, and neither is being past the bound.
            assert.equal(posters.get(IDS[4]), null);
            assert.ok(posters.has(IDS[4]));
            assert.ok(!posters.has(IDS[5]));
            assert.deepEqual(calls.users.map(call => call[0]), IDS.slice(3, 3 + MAX_USER_FETCHES));
            assert.deepEqual(calls.users[0][1], {cache: false});
            assert.ok(!posters.has(IDS[13]));
            // The member cache is left the way it was found.
            assert.deepEqual([...memberCache.keys()], [IDS[0]]);
        });

        test("a member request that fails answers for nobody and asks Discord for nothing more", async () => {
            const {client, calls} = posterClient([], {}, {failChunk: true});
            assert.equal((await quietly(() => createDiscordFacade(client).resolvePosters(GUILD, IDS))).size, 0);
            assert.equal(calls.users.length, 0);
            assert.equal((await createDiscordFacade(client).resolvePosters("999999999999999999", IDS)).size, 0);
            assert.equal((await createDiscordFacade(client).resolvePosters(GUILD, [])).size, 0);
            assert.equal(calls.chunks.length, 1);
        });
    });

    test("notices cannot ping, refresh uses the bot's REST client, reactions are removed by route", async () => {
        const {client, calls, sent} = fakeClient(async () => ({}));
        const facade = createDiscordFacade(client);
        await facade.postNotice("1", "hello");
        assert.deepEqual(sent, [{content: "hello", allowedMentions: {parse: []}}]);
        await assert.rejects(facade.postNotice("2", "hello"));
        assert.deepEqual(await facade.refreshUrls(["a"]), [{original: "a", refreshed: "b"}]);
        assert.deepEqual(calls[0], {route: "/attachments/refresh-urls", options: {body: {attachment_urls: ["a"]}}});
        await facade.removeCameraReaction("300", "400");
        assert.deepEqual(calls[1], {route: `/channels/300/messages/400/reactions/${encodeURIComponent("📸")}/@me`});
        assert.deepEqual(await facade.getGuildInfo(GUILD), {name: "TNCord", iconUrl: null});
        assert.equal(await facade.getGuildInfo("999999999999999999"), null);
    });
});

describe("stored URL helpers", () => {
    test("the stored URL is recovered exactly from rolls and notices", () => {
        const signed = "https://cdn.discordapp.com/attachments/1/2/a_b.png?ex=66f00000&is=66eeae80&hm=abc&";
        assert.equal(getStoredUrlFromContent(signed), signed);
        assert.equal(getStoredUrlFromContent(`${signed}\n\nlook at this https://example.com/other\nPhoto compliments of <@1>`), signed);
        const web = "https://i.example.com/x.png?a=1&b=(2)";
        assert.equal(getStoredUrlFromContent(formatWebAddNotice(USER, web)), web);
        assert.equal(getStoredUrlFromContent("EV Port Status: Available"), null);
        assert.equal(getStoredUrlFromContent(null), null);
    });

    test("only real command names map to tables", () => {
        assert.equal(getTableByCommandName("homies"), "homies");
        assert.equal(getTableByCommandName("cute"), "pets");
        assert.equal(getTableByCommandName("pets"), "pets");
        for(const name of ["toString", "constructor", "__proto__", "users", "homies; DROP TABLE homies", ""]) {
            assert.equal(getTableByCommandName(name), undefined, name);
        }
    });
});
