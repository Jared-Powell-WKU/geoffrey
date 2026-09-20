import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createInternalApi, DiscordFacade, InternalApiDeps, Poster, RefreshedUrl } from "../internalApi";
import { mediaKey, QueryFn } from "../util/imageRemoval";

export const KEY = "k".repeat(40);
export const GUILD = "100000000000000001";
export const OTHER_GUILD = "100000000000000002";
export const USER = "200000000000000001";
export const OTHER_USER = "200000000000000002";
// A member of GUILD who holds its adminRoleName.
export const MOD_USER = "200000000000000003";
// OWNER_USER_ID in the harness. Deliberately in no guild at all.
export const OWNER = "200000000000000004";
export const HOMIES_CHANNEL = "300000000000000001";

export const GUILDS = {
    tncord: {guildId: GUILD, adminRoleName: "Mods", channels: {homies: [HOMIES_CHANNEL, "300000000000000002"], pets: []}},
    clantus: {guildId: OTHER_GUILD, adminRoleName: "Mods", channels: {homies: ["300000000000000003"], pets: ["300000000000000004"]}}
};

export interface FakeRow {
    id: bigint,
    url: string,
    guildId: string,
    userId: string|null,
    createdAt: string|null,
    source: string,
    channelId: string|null,
    messageId: string|null,
    originCheckedAt?: string|null,
    reactionCount?: number|null,
    flashCount?: number|null,
    reactionsCheckedAt?: string|null
}

// Understands exactly the statements internalApi.ts issues and nothing else,
// so an unexpected table name or statement fails the test. It hands back
// BigInt where the real driver does.
export class FakeDb {
    tables: Record<string, FakeRow[]> = {homies: [], pets: []};
    statements: {sql: string, params: unknown[]}[] = [];
    transactions: string[] = [];
    nextId = 1n;
    clock: () => number = Date.now;

    add(table: string, row: Partial<FakeRow> & {url: string}): FakeRow {
        const full: FakeRow = {id: this.nextId++, guildId: GUILD, userId: USER, createdAt: null, source: "discord", channelId: null, messageId: null, reactionCount: null, flashCount: null, reactionsCheckedAt: null, ...row};
        this.tables[table].push(full);
        return full;
    }

    // A stored post: one or more rows of one Discord message, with counts.
    post(table: string, options: {messageId: string, userId?: string|null, files?: number, reactions?: number|null, flashes?: number|null, createdAt?: string|null, channelId?: string}): FakeRow[] {
        const rows: FakeRow[] = [];
        for(let i = 0; i < (options.files ?? 1); i++) {
            rows.push(this.add(table, {
                url: `https://cdn.discordapp.com/attachments/${options.channelId ?? HOMIES_CHANNEL}/${options.messageId}${i}/f${i}.png`,
                guildId: GUILD, userId: options.userId === undefined ? USER : options.userId, createdAt: options.createdAt ?? "2024-05-01 10:00:00",
                channelId: options.channelId ?? HOMIES_CHANNEL, messageId: options.messageId,
                reactionCount: options.reactions ?? null, flashCount: options.flashes ?? null,
                reactionsCheckedAt: options.reactions === undefined || options.reactions === null ? null : "2026-09-01 00:00:00"
            }));
        }
        return rows;
    }

    private table(name: string): FakeRow[] {
        if(!Object.prototype.hasOwnProperty.call(this.tables, name)) throw new Error(`Unexpected table in SQL: ${name}`);
        return this.tables[name];
    }

    // The filter clauses listPage builds, in the order it builds them: the
    // guild, then the scope (the asker's own rows, or the members the pool is
    // narrowed to), then each end of a date filter. What is left of the
    // condition is the cursor's, and so are the parameters that go with it.
    private static scope(rows: FakeRow[], where: string, params: unknown[], sql: string) {
        if(!where.startsWith("guildId = ?")) throw new Error(`Unexpected SQL: ${sql}`);
        let condition = where.slice("guildId = ?".length);
        let values = params.slice(1);
        let matches = rows.filter(r => r.guildId === params[0]);
        let m: RegExpExecArray|null;
        const eat = (clause: string) => {
            if(!condition.startsWith(clause)) return false;
            condition = condition.slice(clause.length);
            return true;
        };
        if(eat(" AND userId = ?")) {
            const userId = values[0];
            matches = matches.filter(r => r.userId === userId);
            values = values.slice(1);
        } else if((m = /^ AND userId IN \(\?(?:, \?)*\)/.exec(condition))) {
            const count = m[0].split("?").length - 1;
            const userIds = values.slice(0, count);
            matches = matches.filter(r => r.userId !== null && userIds.includes(r.userId));
            condition = condition.slice(m[0].length);
            values = values.slice(count);
        }
        // A NULL date is in no stretch of time, as a NULL fails both comparisons.
        if(eat(" AND createdAt >= ?")) {
            const from = values[0] as string;
            matches = matches.filter(r => r.createdAt !== null && r.createdAt >= from);
            values = values.slice(1);
        }
        if(eat(" AND createdAt < ?")) {
            const until = values[0] as string;
            matches = matches.filter(r => r.createdAt !== null && r.createdAt < until);
            values = values.slice(1);
        }
        return {matches, condition, values};
    }

    private static project(row: FakeRow) {
        return {id: row.id, url: row.url, createdAt: row.createdAt === null ? null : row.createdAt.replace(" ", "T") + "Z", source: row.source, channelId: row.channelId, messageId: row.messageId, userId: row.userId};
    }

    query = async (sql: string, params: unknown[] = []): Promise<any> => {
        this.statements.push({sql, params});
        let m: RegExpExecArray|null;
        if(sql === "INSERT IGNORE INTO users (id, guildId) VALUES (?, ?)") return {affectedRows: 1};
        if((m = /^INSERT INTO (\w+) \(url, guildId, userId, createdAt, source\) VALUES \(\?, \?, \?, UTC_TIMESTAMP\(\), 'web'\)$/.exec(sql))) {
            const rows = this.table(m[1]);
            const [url, guildId, userId] = params as string[];
            // The two unique keys: (url, guildId) and (guildId, mediaKey).
            if(rows.some(r => r.guildId === guildId && (r.url === url || mediaKey(r.url) === mediaKey(url)))) {
                throw Object.assign(new Error("Duplicate entry"), {errno: 1062, code: "ER_DUP_ENTRY"});
            }
            const createdAt = new Date(this.clock()).toISOString().slice(0, 19).replace("T", " ");
            const row = this.add(m[1], {url, guildId, userId, createdAt, source: "web"});
            return {affectedRows: 1, insertId: row.id};
        }
        if((m = /^SELECT CAST\(id AS CHAR\) AS id, url, DATE_FORMAT\(createdAt, '%Y-%m-%dT%H:%i:%sZ'\) AS createdAt, source, channelId, messageId, userId FROM (\w+) WHERE (.*)$/.exec(sql))) {
            const rows = this.table(m[1]);
            const where = m[2];
            if(where === "id = CAST(? AS UNSIGNED)") {
                return rows.filter(r => r.id === BigInt(params[0] as string)).map(FakeDb.project);
            }
            const order = " ORDER BY createdAt DESC, id DESC LIMIT ?";
            if(!where.endsWith(order)) throw new Error(`Unexpected SQL: ${sql}`);
            const scoped = FakeDb.scope(rows, where.slice(0, -order.length), params, sql);
            let matches = scoped.matches;
            const rest = scoped.values;
            if(scoped.condition === " AND (createdAt < ? OR (createdAt = ? AND id < CAST(? AS UNSIGNED)) OR createdAt IS NULL)") {
                const [before, same, id] = rest as string[];
                matches = matches.filter(r => r.createdAt === null || r.createdAt < before || (r.createdAt === same && r.id < BigInt(id)));
            } else if(scoped.condition === " AND createdAt IS NULL AND id < CAST(? AS UNSIGNED)") {
                matches = matches.filter(r => r.createdAt === null && r.id < BigInt(rest[0] as string));
            } else if(scoped.condition !== "") {
                throw new Error(`Unexpected SQL: ${sql}`);
            }
            matches.sort(compareNewestFirst);
            return matches.slice(0, params[params.length - 1] as number).map(FakeDb.project);
        }
        if((m = /^SELECT COUNT\(\*\) AS total FROM (\w+) WHERE guildId = \? AND messageId = \?$/.exec(sql))) {
            return [{total: BigInt(this.table(m[1]).filter(r => r.guildId === params[0] && r.messageId === params[1]).length)}];
        }
        // The listings' total, over the same filters as the page itself.
        if((m = /^SELECT COUNT\(\*\) AS total FROM (\w+) WHERE (.*)$/.exec(sql))) {
            const scoped = FakeDb.scope(this.table(m[1]), m[2], params, sql);
            if(scoped.condition !== "") throw new Error(`Unexpected SQL: ${sql}`);
            return [{total: BigInt(scoped.matches.length)}];
        }
        // The posters of a guild, for turning a poster key back into a user id.
        if((m = /^SELECT DISTINCT userId FROM (\w+) WHERE guildId = \? AND userId IS NOT NULL$/.exec(sql))) {
            return [...new Set(this.table(m[1]).filter(r => r.guildId === params[0] && r.userId !== null).map(r => r.userId))].map(userId => ({userId}));
        }
        // The leaderboards. Each statement is one table; the API merges them.
        if((m = /^SELECT userId, COUNT\(\*\) AS score FROM (\w+) WHERE guildId = \? AND userId IS NOT NULL GROUP BY userId$/.exec(sql))) {
            const scores = new Map<string, number>();
            for(const r of this.table(m[1])) if(r.guildId === params[0] && r.userId !== null) scores.set(r.userId, (scores.get(r.userId) || 0) + 1);
            return [...scores].map(([userId, score]) => ({userId, score: BigInt(score)}));
        }
        if((m = /^SELECT userId, SUM\(reactions\) AS score FROM \(SELECT messageId, MIN\(userId\) AS userId, MAX\(reactionCount\) AS reactions FROM (\w+) WHERE guildId = \? AND userId IS NOT NULL AND messageId IS NOT NULL AND reactionCount IS NOT NULL GROUP BY messageId\) posts GROUP BY userId$/.exec(sql))) {
            const posts = new Map<string, {userId: string, reactions: number}>();
            for(const r of this.table(m[1])) {
                if(r.guildId !== params[0] || r.userId === null || r.messageId === null || r.reactionCount === null || r.reactionCount === undefined) continue;
                const post = posts.get(r.messageId);
                if(!post) posts.set(r.messageId, {userId: r.userId, reactions: r.reactionCount});
                else { post.userId = post.userId < r.userId ? post.userId : r.userId; post.reactions = Math.max(post.reactions, r.reactionCount); }
            }
            const scores = new Map<string, number>();
            for(const post of posts.values()) scores.set(post.userId, (scores.get(post.userId) || 0) + post.reactions);
            // The real driver returns a DECIMAL sum as a string.
            return [...scores].map(([userId, score]) => ({userId, score: String(score)}));
        }
        if((m = /^SELECT id, url, createdAt, source, channelId, messageId, userId, (reactionCount|flashCount) AS score, mediaCount FROM \(SELECT CAST\(id AS CHAR\) AS id, url, DATE_FORMAT\(createdAt, '%Y-%m-%dT%H:%i:%sZ'\) AS createdAt, source, channelId, messageId, userId, \1, ROW_NUMBER\(\) OVER \(PARTITION BY messageId ORDER BY id\) AS place, COUNT\(\*\) OVER \(PARTITION BY messageId\) AS mediaCount FROM (\w+) WHERE guildId = \? AND messageId IS NOT NULL AND \1 > 0\) ranked WHERE place = 1 ORDER BY score DESC, createdAt DESC, id DESC LIMIT \?$/.exec(sql))) {
            const column = m[1] as "reactionCount"|"flashCount";
            const rows = this.table(m[2]).filter(r => r.guildId === params[0] && r.messageId !== null && (r[column] ?? 0) > 0);
            const byMessage = new Map<string, FakeRow[]>();
            for(const r of rows) byMessage.set(r.messageId!, [...(byMessage.get(r.messageId!) || []), r]);
            const firsts = [...byMessage.values()].map(group => {
                const sorted = [...group].sort((a, b) => a.id < b.id ? -1 : 1);
                return {row: sorted[0], mediaCount: group.length};
            });
            firsts.sort((a, b) => (b.row[column]! - a.row[column]!) || compareNewestFirst(a.row, b.row));
            return firsts.slice(0, params[1] as number).map(({row, mediaCount}) => ({...FakeDb.project(row), score: row[column], mediaCount: BigInt(mediaCount)}));
        }
        if((m = /^SELECT COUNT\(DISTINCT messageId\) AS total, COUNT\(DISTINCT CASE WHEN reactionsCheckedAt IS NOT NULL THEN messageId END\) AS counted FROM (\w+) WHERE guildId = \? AND messageId IS NOT NULL$/.exec(sql))) {
            const rows = this.table(m[1]).filter(r => r.guildId === params[0] && r.messageId !== null);
            return [{total: BigInt(new Set(rows.map(r => r.messageId)).size), counted: BigInt(new Set(rows.filter(r => r.reactionsCheckedAt).map(r => r.messageId)).size)}];
        }
        // The reaction recounter's writes.
        if((m = /^UPDATE (\w+) SET reactionCount = \?, flashCount = \?, reactionsCheckedAt = UTC_TIMESTAMP\(\) WHERE guildId = \? AND messageId = \?$/.exec(sql))) {
            const hit = this.table(m[1]).filter(r => r.guildId === params[2] && r.messageId === params[3]);
            for(const r of hit) { r.reactionCount = params[0] as number; r.flashCount = params[1] as number; r.reactionsCheckedAt = new Date(this.clock()).toISOString().slice(0, 19).replace("T", " "); }
            return {affectedRows: hit.length};
        }
        if((m = /^UPDATE (\w+) SET reactionsCheckedAt = UTC_TIMESTAMP\(\) WHERE guildId = \? AND messageId = \?$/.exec(sql))) {
            const hit = this.table(m[1]).filter(r => r.guildId === params[0] && r.messageId === params[1]);
            for(const r of hit) r.reactionsCheckedAt = new Date(this.clock()).toISOString().slice(0, 19).replace("T", " ");
            return {affectedRows: hit.length};
        }
        if((m = /^SELECT userId, channelId, messageId FROM (\w+) WHERE id = CAST\(\? AS UNSIGNED\) AND guildId = \?$/.exec(sql))) {
            return this.table(m[1]).filter(r => r.id === BigInt(params[0] as string) && r.guildId === params[1]).map(r => ({userId: r.userId, channelId: r.channelId, messageId: r.messageId}));
        }
        // removeRows for a removal a person asked for, as the API's DELETE route
        // calls it: a plain delete, scoped to the guild, and to the asker too unless
        // the asker is a moderator or the owner. Anything touching the archive is
        // "Unexpected SQL".
        if((m = /^DELETE t FROM (\w+) t WHERE t\.id = CAST\(\? AS UNSIGNED\) AND t\.guildId = \?( AND t\.userId = \?)?$/.exec(sql))) {
            const [id, guildId, userId] = params as string[];
            if(params.length !== (m[2] ? 3 : 2)) throw new Error(`Wrong parameter count for: ${sql}`);
            const rows = this.table(m[1]);
            const kept = rows.filter(r => !(r.id === BigInt(id) && r.guildId === guildId && (!m![2] || r.userId === userId)));
            this.tables[m[1]] = kept;
            return {affectedRows: rows.length - kept.length, insertId: 0n};
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    };

    // One "connection": the statements run through the same fake, and a
    // failure puts the tables back the way a rollback would.
    transaction = async <T>(work: (query: QueryFn) => Promise<T>): Promise<T> => {
        const before = {homies: [...this.tables.homies], pets: [...this.tables.pets]};
        this.transactions.push("begin");
        try {
            const result = await work(this.query);
            this.transactions.push("commit");
            return result;
        } catch(e) {
            this.tables = before;
            this.transactions.push("rollback");
            throw e;
        }
    };
}

// Newest first, unknown dates last, then id descending: the contract's order.
export function compareNewestFirst(a: {createdAt: string|null, id: bigint}, b: {createdAt: string|null, id: bigint}): number {
    if(a.createdAt !== b.createdAt) {
        if(a.createdAt === null) return 1;
        if(b.createdAt === null) return -1;
        return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? 1 : -1;
}

export class FakeDiscord implements DiscordFacade {
    ready = true;
    members = new Set<string>([`${GUILD}:${USER}`, `${OTHER_GUILD}:${USER}`, `${GUILD}:${OTHER_USER}`, `${GUILD}:${MOD_USER}`]);
    // Role names per member; a member without an entry holds no roles.
    roles = new Map<string, string[]>([[`${GUILD}:${MOD_USER}`, ["@everyone", "Mods"]], [`${GUILD}:${USER}`, ["@everyone", "Regulars"]]]);
    // What Discord knows about people, per guild and then globally. A user in
    // neither is unknown to Discord (null).
    guildProfiles = new Map<string, Poster>();
    globalProfiles = new Map<string, Poster>();
    posterLookups: {guildId: string, userIds: string[]}[] = [];
    failPosters = false;
    // Users the facade leaves out of its answer, as when a bound was hit.
    unanswered = new Set<string>();
    knownGuilds: Record<string, {name: string, iconUrl: string|null}> = {
        [GUILD]: {name: "TNCord", iconUrl: "https://cdn.discordapp.com/icons/100000000000000001/abc.webp?size=128"},
        [OTHER_GUILD]: {name: "Clantus", iconUrl: null}
    };
    memberLookups: string[] = [];
    refreshCalls: string[][] = [];
    notices: {channelId: string, content: string}[] = [];
    reactionsRemoved: {channelId: string, messageId: string}[] = [];
    failRefresh = false;
    failNotice = false;
    refreshedExpiry = 0;

    isReady() { return this.ready; }
    async memberRoles(guildId: string, userId: string) {
        this.memberLookups.push(`${guildId}:${userId}`);
        if(!this.knownGuilds[guildId] || !this.members.has(`${guildId}:${userId}`)) return null;
        return this.roles.get(`${guildId}:${userId}`) || ["@everyone"];
    }
    async resolvePosters(guildId: string, userIds: string[]) {
        this.posterLookups.push({guildId, userIds: [...userIds]});
        if(this.failPosters) throw new Error("gateway timeout");
        const result = new Map<string, Poster|null>();
        for(const userId of userIds) {
            if(this.unanswered.has(userId)) continue;
            result.set(userId, this.guildProfiles.get(`${guildId}:${userId}`) ?? this.globalProfiles.get(userId) ?? null);
        }
        return result;
    }
    async getGuildInfo(guildId: string) { return this.knownGuilds[guildId] || null; }
    async refreshUrls(urls: string[]): Promise<RefreshedUrl[]> {
        this.refreshCalls.push(urls);
        if(this.failRefresh) throw new Error("refresh failed");
        return urls.map(original => ({original, refreshed: `${original.split("?")[0]}?ex=${this.refreshedExpiry.toString(16)}&is=1&hm=abc&`}));
    }
    async postNotice(channelId: string, content: string) {
        if(this.failNotice) throw new Error("cannot post");
        this.notices.push({channelId, content});
    }
    async removeCameraReaction(channelId: string, messageId: string) {
        this.reactionsRemoved.push({channelId, messageId});
    }
}

export interface Harness {
    db: FakeDb;
    discord: FakeDiscord;
    clock: {now: number};
    errors: unknown[][];
    base: string;
    request(method: string, path: string, options?: {key?: string|null, body?: unknown, rawBody?: string, headers?: Record<string, string>}): Promise<{status: number, body: any}>;
    close(): Promise<void>;
}

export async function listen(server: http.Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function makeRequester(base: string) {
    return async (method: string, path: string, options: {key?: string|null, body?: unknown, rawBody?: string, headers?: Record<string, string>} = {}) => {
        const headers: Record<string, string> = {...(options.headers || {})};
        if(options.key !== null) headers["Authorization"] = `Bearer ${options.key === undefined ? KEY : options.key}`;
        let body: string|undefined = options.rawBody;
        if(options.body !== undefined) body = JSON.stringify(options.body);
        if(body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetch(base + path, {method, headers, body});
        const text = await response.text();
        return {status: response.status, body: text ? JSON.parse(text) : null};
    };
}

export async function createHarness(overrides: Partial<InternalApiDeps> = {}): Promise<Harness> {
    const db = new FakeDb();
    const discord = new FakeDiscord();
    const clock = {now: Date.UTC(2026, 8, 19, 12, 0, 0)};
    const errors: unknown[][] = [];
    db.clock = () => clock.now;
    discord.refreshedExpiry = Math.floor(clock.now / 1000) + 24 * 3600;
    const server = createInternalApi({
        config: {key: KEY, guilds: GUILDS, ownerUserId: OWNER},
        query: db.query,
        transaction: db.transaction,
        discord,
        now: () => clock.now,
        log: {info: () => {}, warn: () => {}, error: (...args: unknown[]) => { errors.push(args); }},
        ...overrides
    });
    const base = await listen(server);
    return {
        db, discord, clock, errors, base,
        request: makeRequester(base),
        close: () => new Promise<void>(resolve => {
            server.close(() => resolve());
            server.closeAllConnections();
        })
    };
}

// The mediaKey rule on tricky URLs: the unit test holds the TypeScript
// function to it, the integration test holds the generated column in MariaDB to it.
export const MEDIA_KEY_CASES: [string, string][] = [
    ["https://cdn.discordapp.com/attachments/12/34/a.png", "discord:12/34"],
    ["https://cdn.discordapp.com/attachments/12/34/a.png?ex=66f00000&is=66eeae80&hm=abc&", "discord:12/34"],
    ["https://cdn.discordapp.com/attachments/12/34/renamed%20file_(1).JPG?ex=77777777&is=1&hm=2&", "discord:12/34"],
    ["https://media.discordapp.net/attachments/12/34/a.png?width=400&height=300", "discord:12/34"],
    ["https://cdn.discordapp.com/attachments/700000000000000001/1100000000000000000/x.png", "discord:700000000000000001/1100000000000000000"],
    ["https://cdn.discordapp.com/attachments/12/34/", "discord:12/34"],
    ["https://cdn.discordapp.com/attachments/12/34/a/b/c.png", "discord:12/34"],
    ["https://cdn.discordapp.com/attachments/012/0034/a.png", "discord:012/0034"]
];
// Everything that only looks like an attachment is its own key.
export const OWN_KEY_CASES: string[] = [
    "https://cdn.discordapp.com/attachments/12/34",
    "https://cdn.discordapp.com/attachments/12/34?ex=1",
    "https://cdn.discordapp.com/attachments/12/x34/a.png",
    "https://cdn.discordapp.com/attachments/1x2/34/a.png",
    "https://cdn.discordapp.com/attachments//34/a.png",
    "https://cdn.discordapp.com/attachments/12//a.png",
    "https://cdn.discordapp.com/attachments/12 /34/a.png",
    "https://cdn.discordapp.com/attachments/-12/34/a.png",
    "https://cdn.discordapp.com/attachments/12.0/34/a.png",
    "https://cdn.discordapp.com/avatars/12/34/a.png",
    "https://cdn.discordapp.com/ephemeral-attachments/12/34/a.png",
    "https://cdn.discordapp.com//attachments/12/34/a.png",
    "https://cdn.discordapp.com.example.com/attachments/12/34/a.png",
    "https://cdnXdiscordapp.com/attachments/12/34/a.png",
    "https://evil.example/https://cdn.discordapp.com/attachments/12/34/a.png",
    "https://example.com/attachments/12/34/a.png",
    "https://images-ext-1.discordapp.net/external/abc/https/example.com/a.png",
    "http://cdn.discordapp.com/attachments/12/34/a.png",
    "HTTPS://cdn.discordapp.com/attachments/12/34/a.png",
    "https://CDN.discordapp.com/attachments/12/34/a.png",
    "https://cdn.discordapp.com/Attachments/12/34/a.png",
    "https://example.com/i.php?id=1",
    "https://example.com/i.php?id=2",
    "discord:12/34"
];
