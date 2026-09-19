import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { classifyProbe, confirmDead, formatSummary, LOOKUP_INTERVAL_MS, MessageLookup, parseArgs, PROBE_CONCURRENCY, REFRESH_BATCH_SIZE, sweep, SweepDeps, SweepRow } from "../maintenance/sweepDeadMedia";

const cdn = (attachmentId: string, channelId: string = "700") => `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/pic.png`;

// A stubbed Discord: what the CDN answers per attachment id and what the
// channel lookup returns per attachment id.
function world(rows: SweepRow[], cdnStatus: Record<string, number>, lookups: Record<string, MessageLookup>) {
    const calls = {refresh: [] as string[][], probe: [] as string[], lookup: [] as string[], archive: [] as SweepRow[], sleep: [] as number[], log: [] as string[]};
    let probing = 0;
    let maxProbing = 0;
    const deps: SweepDeps = {
        listRows: async (limit) => limit === null ? rows : rows.slice(0, limit),
        refreshUrls: async (urls) => {
            calls.refresh.push(urls);
            return urls.filter(url => !url.includes("/unrefreshable/")).map(original => ({original, refreshed: `${original}?ex=77777777&is=1&hm=2&`}));
        },
        probe: async (url) => {
            calls.probe.push(url);
            maxProbing = Math.max(maxProbing, ++probing);
            await new Promise(resolve => setImmediate(resolve));
            probing--;
            const id = url.split("/")[5];
            return cdnStatus[id] ?? 200;
        },
        lookupMessages: async (channelId, attachmentId) => {
            calls.lookup.push(`${channelId}/${attachmentId}`);
            return lookups[attachmentId] ?? {status: 200, messages: []};
        },
        archive: async (row) => { calls.archive.push(row); return 1; },
        sleep: async (ms) => { calls.sleep.push(ms); },
        log: (line) => { calls.log.push(line); }
    };
    return {deps, calls, maxProbing: () => maxProbing};
}

const ROWS: SweepRow[] = [
    {category: "homies", id: "1", url: cdn("1001")},                      // 404, message gone
    {category: "homies", id: "2", url: cdn("1002")},                      // 404, but still posted
    {category: "homies", id: "3", url: cdn("1003")},                      // 404, lookup 403
    {category: "homies", id: "4", url: cdn("1004")},                      // 200
    {category: "homies", id: "5", url: "https://example.com/a.png"},      // not Discord
    {category: "pets", id: "1", url: cdn("1006")},                        // 404, lookup 404 (channel gone)
    {category: "pets", id: "2", url: cdn("1007")},                        // 404, lookup 5xx
    {category: "pets", id: "3", url: cdn("1008")},                        // 404, rate limited
    {category: "pets", id: "4", url: cdn("1009")},                        // CDN 403
    {category: "pets", id: "5", url: cdn("1010")},                        // CDN did not answer
    {category: "pets", id: "6", url: "https://media.discordapp.net/attachments/700/1011/pic.png"}, // 404, gone
    {category: "pets", id: "7", url: "https://cdn.discordapp.com/attachments/700/1012/unrefreshable/x.png"}
];
const CDN = {"1001": 404, "1002": 404, "1003": 404, "1006": 404, "1007": 404, "1008": 404, "1009": 403, "1010": 0, "1011": 404};
const LOOKUPS: Record<string, MessageLookup> = {
    "1001": {status: 200, messages: [{attachments: [{id: "999"}]}, {attachments: []}, {}]},
    "1002": {status: 200, messages: [{attachments: []}, {attachments: [{id: "555"}, {id: "1002"}]}]},
    "1003": {status: 403, messages: []},
    "1006": {status: 404, messages: []},
    "1007": {status: 503, messages: []},
    "1008": {status: 429, messages: []},
    "1011": {status: 200, messages: []}
};

describe("decision rules", () => {
    test("only a 404 makes a candidate", () => {
        assert.equal(classifyProbe(404), "candidate");
        for(const status of [200, 206]) assert.equal(classifyProbe(status), "alive");
        for(const status of [0, 301, 400, 401, 403, 410, 429, 500, 503]) assert.equal(classifyProbe(status), "probe_inconclusive", String(status));
    });

    test("a candidate is dead only on a successful lookup without the attachment", () => {
        assert.equal(confirmDead({status: 200, messages: []}, "5"), "dead");
        assert.equal(confirmDead({status: 200, messages: [{attachments: [{id: "4"}]}, {}]}, "5"), "dead");
        assert.equal(confirmDead({status: 200, messages: [{attachments: [{id: "4"}, {id: "5"}]}]}, "5"), "still_posted");
        for(const status of [0, 401, 403, 404, 429, 500, 502]) assert.equal(confirmDead({status, messages: []}, "5"), "unconfirmed", String(status));
        assert.equal(confirmDead({status: 200, messages: null as any}, "5"), "unconfirmed");
    });
});

describe("sweep", () => {
    test("a dry run classifies every row and writes nothing", async () => {
        const {deps, calls} = world(ROWS, CDN, LOOKUPS);
        const summary = await sweep(deps, {apply: false, limit: null});
        assert.deepEqual(summary.counts, {
            homies: {dead: 1, still_posted: 1, unconfirmed: 1, alive: 1, not_discord: 1},
            pets: {unconfirmed: 3, probe_inconclusive: 2, dead: 1, refresh_failed: 1}
        });
        assert.deepEqual(summary.dead.map(r => `${r.category} ${r.id}`), ["homies 1", "pets 6"]);
        assert.equal(summary.archived, 0);
        assert.equal(calls.archive.length, 0);
        // Non-Discord URLs are never sent anywhere.
        assert.ok(!calls.refresh.flat().includes("https://example.com/a.png"));
        assert.ok(!calls.probe.some(url => url.includes("example.com")));
        // The refreshed URL is what gets probed, and only 404s are looked up, in their own channel.
        assert.ok(calls.probe.every(url => url.includes("?ex=77777777")));
        assert.deepEqual(calls.lookup.sort(), ["1001", "1002", "1003", "1006", "1007", "1008", "1011"].map(id => `700/${id}`));
        assert.deepEqual(calls.sleep, new Array(6).fill(LOOKUP_INTERVAL_MS));
        const lines = formatSummary(summary);
        assert.match(lines[0], /^DRY RUN/);
        assert.ok(lines.includes("  homies 1") && lines.includes("  pets 6"));
        assert.ok(!lines.join("\n").includes("https://"), "the summary names rows by category and id only");
    });

    test("--apply archives exactly the dead rows", async () => {
        const {deps, calls} = world(ROWS, CDN, LOOKUPS);
        const summary = await sweep(deps, {apply: true, limit: null});
        assert.deepEqual(calls.archive, [ROWS[0], ROWS[10]]);
        assert.equal(summary.archived, 2);
        assert.match(formatSummary(summary).join("\n"), /Archived as gone_from_discord and removed: 2/);
    });

    test("--limit bounds the rows, refreshes go in batches of 50 and probes run 8 at a time", async () => {
        const many = new Array(120).fill(0).map((_, i) => ({category: "homies", id: String(i), url: cdn(String(5000 + i))}));
        const limited = world(many, {}, {});
        assert.equal((await sweep(limited.deps, {apply: true, limit: 7})).checked, 7);
        const all = world(many, {}, {});
        const summary = await sweep(all.deps, {apply: true, limit: null});
        assert.deepEqual(all.calls.refresh.map(batch => batch.length), [REFRESH_BATCH_SIZE, REFRESH_BATCH_SIZE, 20]);
        assert.equal(all.maxProbing(), PROBE_CONCURRENCY);
        assert.deepEqual(summary.counts, {homies: {alive: 120}});
        assert.equal(all.calls.archive.length, 0);
    });

    test("a failed refresh call leaves its whole batch alone", async () => {
        const {deps, calls} = world(ROWS.slice(0, 4), CDN, LOOKUPS);
        deps.refreshUrls = async () => { throw new Error("401: Unauthorized"); };
        const summary = await sweep(deps, {apply: true, limit: null});
        assert.deepEqual(summary.counts, {homies: {refresh_failed: 4}});
        assert.equal(calls.probe.length + calls.lookup.length + calls.archive.length, 0);
        assert.equal(calls.log.length, 1);
    });

    test("arguments", () => {
        assert.deepEqual(parseArgs([]), {apply: false, limit: null});
        assert.deepEqual(parseArgs(["--limit", "25", "--apply"]), {apply: true, limit: 25});
        for(const bad of [["--limit"], ["--limit", "0"], ["--limit", "-5"], ["--limit", "x"], ["--aply"], ["apply"]]) assert.equal(parseArgs(bad), null, bad.join(" "));
    });
});
