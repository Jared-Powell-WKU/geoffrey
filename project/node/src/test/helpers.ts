import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createInternalApi, DiscordFacade, InternalApiDeps, RefreshedUrl } from "../internalApi";
import { mediaKey, QueryFn } from "../util/imageRemoval";

export const KEY = "k".repeat(40);
export const GUILD = "100000000000000001";
export const OTHER_GUILD = "100000000000000002";
export const USER = "200000000000000001";
export const OTHER_USER = "200000000000000002";
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
    messageId: string|null
}

// Understands exactly the statements internalApi.ts issues and nothing else,
// so an unexpected table name or statement fails the test. It hands back
// BigInt where the real driver does.
export class FakeDb {
    tables: Record<string, FakeRow[]> = {homies: [], pets: []};
    archive: (FakeRow & {category: string, reason: string})[] = [];
    statements: {sql: string, params: unknown[]}[] = [];
    transactions: string[] = [];
    nextId = 1n;
    clock: () => number = Date.now;

    add(table: string, row: Partial<FakeRow> & {url: string}): FakeRow {
        const full: FakeRow = {id: this.nextId++, guildId: GUILD, userId: USER, createdAt: null, source: "discord", channelId: null, messageId: null, ...row};
        this.tables[table].push(full);
        return full;
    }

    private table(name: string): FakeRow[] {
        if(!Object.prototype.hasOwnProperty.call(this.tables, name)) throw new Error(`Unexpected table in SQL: ${name}`);
        return this.tables[name];
    }

    private static project(row: FakeRow) {
        return {id: row.id, url: row.url, createdAt: row.createdAt === null ? null : row.createdAt.replace(" ", "T") + "Z", source: row.source};
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
        if((m = /^SELECT CAST\(id AS CHAR\) AS id, url, DATE_FORMAT\(createdAt, '%Y-%m-%dT%H:%i:%sZ'\) AS createdAt, source FROM (\w+) WHERE (.*)$/.exec(sql))) {
            const rows = this.table(m[1]);
            const where = m[2];
            if(where === "id = CAST(? AS UNSIGNED)") {
                return rows.filter(r => r.id === BigInt(params[0] as string)).map(FakeDb.project);
            }
            const order = " ORDER BY createdAt DESC, id DESC LIMIT ?";
            if(!where.endsWith(order)) throw new Error(`Unexpected SQL: ${sql}`);
            const condition = where.slice(0, -order.length);
            let matches = rows.filter(r => r.guildId === params[0] && r.userId === params[1]);
            if(condition === "guildId = ? AND userId = ? AND (createdAt < ? OR (createdAt = ? AND id < CAST(? AS UNSIGNED)) OR createdAt IS NULL)") {
                const [, , before, same, id] = params as string[];
                matches = matches.filter(r => r.createdAt === null || r.createdAt < before || (r.createdAt === same && r.id < BigInt(id)));
            } else if(condition === "guildId = ? AND userId = ? AND createdAt IS NULL AND id < CAST(? AS UNSIGNED)") {
                matches = matches.filter(r => r.createdAt === null && r.id < BigInt(params[2] as string));
            } else if(condition !== "guildId = ? AND userId = ?") {
                throw new Error(`Unexpected SQL: ${sql}`);
            }
            matches.sort(compareNewestFirst);
            return matches.slice(0, params[params.length - 1] as number).map(FakeDb.project);
        }
        if((m = /^SELECT COUNT\(\*\) AS total FROM (\w+) WHERE guildId = \? AND userId = \?$/.exec(sql))) {
            return [{total: BigInt(this.table(m[1]).filter(r => r.guildId === params[0] && r.userId === params[1]).length)}];
        }
        if((m = /^SELECT COUNT\(\*\) AS total FROM (\w+) WHERE guildId = \? AND messageId = \?$/.exec(sql))) {
            return [{total: BigInt(this.table(m[1]).filter(r => r.guildId === params[0] && r.messageId === params[1]).length)}];
        }
        if((m = /^SELECT channelId, messageId FROM (\w+) WHERE id = CAST\(\? AS UNSIGNED\) AND guildId = \? AND userId = \?$/.exec(sql))) {
            return this.table(m[1]).filter(r => r.id === BigInt(params[0] as string) && r.guildId === params[1] && r.userId === params[2]).map(r => ({channelId: r.channelId, messageId: r.messageId}));
        }
        // archiveAndDelete, as the API's DELETE route calls it.
        const owned = "t.id = CAST(? AS UNSIGNED) AND t.guildId = ? AND t.userId = ?";
        if((m = /^INSERT INTO submissions_archive \(category, id, url, guildId, userId, createdAt, source, channelId, messageId, reason\) SELECT \?, t\.id, t\.url, t\.guildId, t\.userId, t\.createdAt, t\.source, t\.channelId, t\.messageId, \? FROM (\w+) t WHERE (.*)$/.exec(sql)) && m[2] === owned) {
            const [category, reason, id, guildId, userId] = params as string[];
            const matches = this.table(m[1]).filter(r => r.id === BigInt(id) && r.guildId === guildId && r.userId === userId);
            this.archive.push(...matches.map(r => ({...r, category, reason})));
            return {affectedRows: matches.length, insertId: 0n};
        }
        if((m = /^DELETE t FROM (\w+) t STRAIGHT_JOIN submissions_archive a ON a\.category = \? AND a\.id = t\.id AND a\.reason = \? WHERE (.*)$/.exec(sql)) && m[2] === owned) {
            const [category, reason, id, guildId, userId] = params as string[];
            const rows = this.table(m[1]);
            const kept = rows.filter(r => !(r.id === BigInt(id) && r.guildId === guildId && r.userId === userId && this.archive.some(a => a.category === category && a.reason === reason && a.id === r.id)));
            this.tables[m[1]] = kept;
            return {affectedRows: rows.length - kept.length, insertId: 0n};
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    };

    // One "connection": the statements run through the same fake, and a
    // failure puts the tables back the way a rollback would.
    transaction = async <T>(work: (query: QueryFn) => Promise<T>): Promise<T> => {
        const before = {tables: {homies: [...this.tables.homies], pets: [...this.tables.pets]}, archive: [...this.archive]};
        this.transactions.push("begin");
        try {
            const result = await work(this.query);
            this.transactions.push("commit");
            return result;
        } catch(e) {
            this.tables = before.tables;
            this.archive = before.archive;
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
    members = new Set<string>([`${GUILD}:${USER}`, `${OTHER_GUILD}:${USER}`, `${GUILD}:${OTHER_USER}`]);
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
    async isMember(guildId: string, userId: string) {
        this.memberLookups.push(`${guildId}:${userId}`);
        return this.members.has(`${guildId}:${userId}`);
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
        config: {key: KEY, guilds: GUILDS},
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
