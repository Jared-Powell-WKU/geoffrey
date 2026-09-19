import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { createInternalApi, createDiscordFacade, decodeCursor, encodeCursor, parseCdnExpiry, startInternalApi, validateSubmissionUrl } from "../internalApi";
import { formatWebAddNotice, getStoredUrlFromContent } from "../util/storedUrl";
import { getTableByCommandName } from "../util/tables";
import { compareNewestFirst, createHarness, FakeDb, FakeDiscord, GUILD, GUILDS, Harness, HOMIES_CHANNEL, KEY, OTHER_GUILD, OTHER_USER, USER } from "./helpers";

const STRANGER = "200000000000000009";
const list = (query: string) => `/v1/guilds/${GUILD}/submissions?${query}`;

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
        for(const [method, path] of [["GET", "/v1/nope"], ["GET", "/v2/health"], ["PUT", list(`userId=${USER}&category=homies`)], ["GET", `/v1/guilds/${GUILD}/submissions/homies/1`], ["POST", "/v1/health"], ["GET", `/v1/users/${USER}/guilds/`]]) {
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
        assert.equal(h.discord.memberLookups.length, 0);
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
            {guildId: GUILD, key: "tncord", name: "TNCord", iconUrl: "https://cdn.discordapp.com/icons/100000000000000001/abc.webp?size=128", categories: ["homies"]},
            {guildId: OTHER_GUILD, key: "clantus", name: "Clantus", iconUrl: null, categories: ["homies", "pets"]}
        ]});
        assert.deepEqual((await h.request("GET", `/v1/users/${OTHER_USER}/guilds`)).body.guilds.map((g: any) => g.key), ["tncord"]);
        assert.deepEqual(await h.request("GET", `/v1/users/${STRANGER}/guilds`), {status: 200, body: {guilds: []}});
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
            items: [{id: String(mine.id), category: "homies", url: mine.url, displayUrl: mine.url, createdAt: "2024-05-01T10:00:00Z", source: "discord"}],
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

    test("cursor encoding round trips and rejects tampering", () => {
        assert.deepEqual(decodeCursor(encodeCursor("2024-01-02T03:04:05Z", "18446744073709551615")), {createdAt: "2024-01-02T03:04:05Z", id: "18446744073709551615"});
        assert.deepEqual(decodeCursor(encodeCursor(null, "7")), {createdAt: null, id: "7"});
        for(const raw of ["", "e30", "bnVsbA", Buffer.from('{"c":"2024-01-02 03:04:05","i":"1"}').toString("base64url"), Buffer.from('{"c":null,"i":1}').toString("base64url"), "a".repeat(300)]) {
            assert.equal(decodeCursor(raw), null, raw);
        }
    });
});

describe("adding", () => {
    const path = `/v1/guilds/${GUILD}/submissions`;
    const url = "https://i.example.com/cat.png?x=1&y=<2>";

    test("stores the URL as given, returns the row and posts the notice in the first channel", async () => {
        const res = await h.request("POST", path, {body: {userId: USER, category: "homies", url}});
        assert.equal(res.status, 201);
        assert.deepEqual(res.body, {item: {id: "1", category: "homies", url, displayUrl: url, createdAt: "2026-09-19T12:00:00Z", source: "web"}});
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
    test("another user's row is 404 and survives", async () => {
        const theirs = h.db.add("homies", {url: "https://example.com/theirs.png", userId: OTHER_USER, channelId: "1", messageId: "2"});
        const orphan = h.db.add("homies", {url: "https://example.com/orphan.png", userId: null});
        const elsewhere = h.db.add("homies", {url: "https://example.com/elsewhere.png", guildId: OTHER_GUILD});
        for(const row of [theirs, orphan, elsewhere]) {
            const res = await h.request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/${row.id}?userId=${USER}`);
            assert.equal(res.status, 404);
            assert.equal(res.body.error.code, "NOT_FOUND");
        }
        // Same answer as for an id that does not exist at all.
        assert.equal((await h.request("DELETE", `/v1/guilds/${GUILD}/submissions/homies/9999?userId=${USER}`)).status, 404);
        assert.equal(h.db.tables.homies.length, 3);
        assert.equal(h.discord.reactionsRemoved.length, 0);
    });

    test("ids are per category", async () => {
        const row = h.db.add("homies", {url: "https://example.com/mine.png"});
        assert.equal((await h.request("DELETE", `/v1/guilds/${GUILD}/submissions/pets/${row.id}?userId=${USER}`)).status, 404);
        assert.equal(h.db.tables.homies.length, 1);
    });

    test("the owner can delete, and the camera reaction goes with the last row of a message", async () => {
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
        // Nothing is hard-deleted: each row went to the archive, inside a transaction.
        assert.deepEqual(h.db.archive.map(a => [a.category, a.id, a.url, a.reason]), [first, second, web].map(r => ["homies", r.id, r.url, "removed_on_site"]));
        assert.deepEqual(h.db.transactions, ["begin", "commit", "begin", "commit", "begin", "commit", "begin", "commit"]);
        assert.ok(!h.db.statements.some(s => /^DELETE FROM/.test(s.sql)), "a plain DELETE would bypass the archive");
    });

    test("a delete that cannot be archived deletes nothing", async () => {
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
            assert.equal(h.db.archive.length, 0);
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

    test("Unknown Member and Unknown User mean not a member; other errors propagate", async () => {
        for(const code of [10007, 10013]) {
            const {client} = fakeClient(async () => { throw Object.assign(new Error("Unknown"), {code}); });
            assert.equal(await createDiscordFacade(client).isMember(GUILD, USER), false);
        }
        const {client: failing} = fakeClient(async () => { throw Object.assign(new Error("Server error"), {code: 0, status: 500}); });
        await assert.rejects(createDiscordFacade(failing).isMember(GUILD, USER), /Server error/);

        const {client, calls} = fakeClient(async () => ({}));
        assert.equal(await createDiscordFacade(client).isMember(GUILD, USER), true);
        // The member cache is never invalidated without the GuildMembers intent.
        assert.deepEqual(calls, [{user: USER, force: true, cache: false}]);
        assert.equal(await createDiscordFacade(client).isMember("999999999999999999", USER), false);
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
