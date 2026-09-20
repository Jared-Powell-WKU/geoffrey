// Private HTTP API consumed by cantus.dev. The contract lives in the cantus.dev
// repo at docs/geoffrey-internal-api.md; change it there first.
import * as http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { Client, Routes } from "discord.js";
import { getTableByCommandName } from "./util/tables";
import { formatWebAddNotice } from "./util/storedUrl";
import { removeRows, QueryFn, TransactionFn } from "./util/imageRemoval";
// Type-only: importing util.ts for real would open the database pool.
import type { GuildDictionary, SupportedGuild } from "./util/util";

export type Category = "homies" | "pets";
const CATEGORIES: readonly Category[] = ["homies", "pets"];

export const MIN_KEY_LENGTH = 32;
export const DEFAULT_PORT = 8787;
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_LIMIT = 48;
export const MAX_URL_LENGTH = 1024;
export const REFRESH_BATCH_SIZE = 50;
const ACCESS_TTL_MS = 60_000;
const POSTER_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
// The droplet has 1 GB of RAM in total, so every cache is bounded.
// Access and poster entries are a few dozen bytes each.
const MAX_CACHE_ENTRIES = 5000;
// Refreshed display URLs. One guild's pool is about 6,400 rows, and browsing it
// must not evict what the previous pages just paid a Discord call for, so the
// bound has to hold every stored row with room to grow: 20,000 is about three
// times today's database. An entry is two URL strings (the longest stored one
// is 389 characters, a refreshed one about 250) plus the Map slot, well under
// 1 KB, so a full cache is 10 to 20 MB. Entries are replaced in place when
// their signature expires (about a day), so it only fills as far as there are
// distinct stored URLs.
export const MAX_REFRESH_CACHE_ENTRIES = 20_000;
// Request Guild Members takes at most 100 user ids.
const MEMBER_CHUNK_SIZE = 100;
const MEMBER_CHUNK_TIMEOUT_MS = 5_000;
// People who left the guild cost one REST call each; the rest of a page waits
// for the next request instead of queueing behind Discord's rate limit.
export const MAX_USER_FETCHES = 10;
const AVATAR_SIZE = 64;
const CDN_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];
const DISCORD_ID = /^[0-9]{5,25}$/;
const ROW_ID = /^[0-9]{1,20}$/;
const CURSOR_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ER_DUP_ENTRY = 1062;
// Unknown Member, Unknown User.
const NOT_A_MEMBER_CODES = [10007, 10013];
const UNKNOWN_USER = 10013;
const CAMERA = "📸";

export type { QueryFn, TransactionFn };

export interface RefreshedUrl {
    original: string,
    refreshed: string
}

export interface Poster {
    name: string|null,
    avatarUrl: string|null
}

export interface DiscordFacade {
    isReady(): boolean;
    // The names of the roles the user holds in that guild, asked of Discord
    // afresh. Null when the user is not a member or the bot is not in the guild.
    memberRoles(guildId: string, userId: string): Promise<string[]|null>;
    // How that guild shows these users. A user missing from the result was not
    // looked up (a bound was hit, or Discord did not answer) and may be asked
    // about again; null means Discord does not know the account.
    resolvePosters(guildId: string, userIds: string[]): Promise<Map<string, Poster|null>>;
    // Null when the bot is not in that guild.
    getGuildInfo(guildId: string): Promise<{name: string, iconUrl: string|null}|null>;
    refreshUrls(urls: string[]): Promise<RefreshedUrl[]>;
    postNotice(channelId: string, content: string): Promise<void>;
    removeCameraReaction(channelId: string, messageId: string): Promise<void>;
}

type Logger = Pick<Console, "info"|"warn"|"error">;

export interface InternalApiDeps {
    config: {
        key: string,
        guilds: GuildDictionary,
        // OWNER_USER_ID. Null, absent or not a Discord id: nobody is the owner.
        ownerUserId?: string|null
    };
    query: QueryFn;
    transaction: TransactionFn;
    discord: DiscordFacade;
    now?: () => number;
    log?: Logger;
}

interface Submission {
    id: string,
    category: Category,
    url: string,
    displayUrl: string,
    createdAt: string|null,
    source: "discord"|"web",
    messageUrl: string|null
}

interface PoolItem extends Submission {
    poster: Poster,
    mine: boolean,
    canDelete: boolean
}

interface Access {
    member: boolean,
    moderator: boolean
}

// Null for an unset value. An invalid one is reported as such so the caller can warn.
export function parseOwnerUserId(raw: string|undefined): {ownerUserId: string|null, invalid: boolean} {
    const value = (raw || "").trim();
    if(!value) return {ownerUserId: null, invalid: false};
    return DISCORD_ID.test(value) ? {ownerUserId: value, invalid: false} : {ownerUserId: null, invalid: true};
}

export function messageUrlOf(guildId: string, channelId: unknown, messageId: unknown): string|null {
    if(typeof channelId !== "string" || typeof messageId !== "string") return null;
    // The site renders this as a link, so only real snowflakes make one.
    if(!DISCORD_ID.test(channelId) || !DISCORD_ID.test(messageId)) return null;
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}

const invalid = (message: string) => new ApiError(400, "INVALID_REQUEST", message);
const notFound = (message: string = "Not found.") => new ApiError(404, "NOT_FOUND", message);

// Returns a reason the URL is unacceptable, or null when it is fine.
export function validateSubmissionUrl(url: unknown): string|null {
    if(typeof url !== "string" || !url.length) return "url must be a non-empty string.";
    if(url.length > MAX_URL_LENGTH) return `url must be at most ${MAX_URL_LENGTH} characters.`;
    if(!/^[\x21-\x7E]+$/.test(url)) return "url must be printable ASCII without whitespace.";
    // Lowercase on purpose: reaction-based removal finds the URL in the notice with a case-sensitive match.
    if(!url.startsWith("https://")) return "url must start with https://.";
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch(e) {
        return "url is not a valid URL.";
    }
    if(parsed.protocol !== "https:") return "url must use https.";
    if(parsed.username || parsed.password) return "url must not contain credentials.";
    if(!/^[^.]+(\.[^.]+)+$/.test(parsed.hostname)) return "url must have a hostname with at least one dot.";
    return null;
}

// Expiry of a signed Discord CDN URL in ms since the epoch, from its `ex`
// parameter (hex unix seconds). Null when the URL is unsigned or malformed.
export function parseCdnExpiry(url: string): number|null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch(e) {
        return null;
    }
    const ex = parsed.searchParams.get("ex");
    if(!ex || !/^[0-9a-fA-F]{1,12}$/.test(ex)) return null;
    if(!parsed.searchParams.get("is") || !parsed.searchParams.get("hm")) return null;
    return parseInt(ex, 16) * 1000;
}

function isDiscordCdnUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && CDN_HOSTS.includes(parsed.hostname);
    } catch(e) {
        return false;
    }
}

export function encodeCursor(createdAt: string|null, id: string): string {
    return Buffer.from(JSON.stringify({c: createdAt, i: id}), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): {createdAt: string|null, id: string}|null {
    if(!cursor.length || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if(typeof parsed !== "object" || parsed === null) return null;
        const {c, i} = parsed;
        if(typeof i !== "string" || !ROW_ID.test(i)) return null;
        if(c !== null && (typeof c !== "string" || !CURSOR_DATE.test(c))) return null;
        return {createdAt: c, id: i};
    } catch(e) {
        return null;
    }
}

// Map iteration order is insertion order, so the first key is the oldest.
function setBounded<V>(cache: Map<string, V>, key: string, value: V, maxEntries: number = MAX_CACHE_ENTRIES) {
    cache.delete(key);
    cache.set(key, value);
    while(cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if(oldest === undefined) break;
        cache.delete(oldest);
    }
}

export function createInternalApi(deps: InternalApiDeps): http.Server {
    const {config, query, transaction, discord} = deps;
    const now = deps.now || Date.now;
    const log: Logger = deps.log || console;
    if(typeof config.key !== "string" || config.key.length < MIN_KEY_LENGTH) {
        throw new Error(`The internal API key must be at least ${MIN_KEY_LENGTH} characters.`);
    }
    const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();
    const keyDigest = sha256(config.key);
    // Anything that is not a Discord id can never equal a validated userId.
    const ownerUserId = typeof config.ownerUserId === "string" && DISCORD_ID.test(config.ownerUserId) ? config.ownerUserId : null;
    const accessCache = new Map<string, {access: Access, expiresAt: number}>();
    const posterCache = new Map<string, {poster: Poster, expiresAt: number}>();
    const refreshCache = new Map<string, {displayUrl: string, expiresAt: number}>();

    function isAuthorized(header: string|undefined): boolean {
        const match = /^Bearer (.+)$/i.exec(header || "");
        // Compare even when the header is missing so that path is not faster.
        const equal = timingSafeEqual(sha256(match ? match[1] : ""), keyDigest);
        return !!match && equal;
    }

    function getGuild(guildId: string): {key: string, guild: SupportedGuild} {
        for(const [key, guild] of Object.entries(config.guilds)) {
            if(guild?.guildId === guildId) return {key, guild};
        }
        throw notFound("Unsupported guild.");
    }

    function channelsFor(guild: SupportedGuild, category: Category): string[] {
        const channels = guild.channels?.[category];
        return Array.isArray(channels) ? channels : [];
    }

    // The only way a category from a request becomes part of SQL text.
    function tableFor(category: Category): string {
        const table = getTableByCommandName(category);
        if(!table) throw invalid("Unknown category.");
        return table;
    }

    function parseCategory(value: unknown): Category {
        if(typeof value !== "string" || !CATEGORIES.includes(value as Category)) {
            throw invalid("category must be homies or pets.");
        }
        return value as Category;
    }

    function parseDiscordId(value: unknown, name: string): string {
        if(typeof value !== "string" || !DISCORD_ID.test(value)) throw invalid(`${name} is not a valid Discord id.`);
        return value;
    }

    // Membership and moderator status come from the same answer and are cached
    // together. A moderator holds the role named adminRoleName, the rule
    // checkForImageDeletion in events.ts applies to reactions.
    async function getAccess(guild: SupportedGuild, userId: string): Promise<Access> {
        if(ownerUserId !== null && userId === ownerUserId) {
            // The owner need not be in the guild, but the bot must be.
            const present = await discord.getGuildInfo(guild.guildId) !== null;
            return {member: present, moderator: present};
        }
        const cacheKey = `${guild.guildId}:${userId}`;
        const cached = accessCache.get(cacheKey);
        if(cached && cached.expiresAt > now()) return cached.access;
        const roles = await discord.memberRoles(guild.guildId, userId);
        const adminRole = typeof guild.adminRoleName === "string" ? guild.adminRoleName : "";
        const access: Access = {member: roles !== null, moderator: roles !== null && adminRole.length > 0 && roles.includes(adminRole)};
        setBounded(accessCache, cacheKey, {access, expiresAt: now() + ACCESS_TTL_MS});
        return access;
    }

    async function requireMember(guild: SupportedGuild, userId: string): Promise<Access> {
        const access = await getAccess(guild, userId);
        if(!access.member) throw new ApiError(403, "NOT_A_MEMBER", "The user is not a member of that guild.");
        return access;
    }

    // Never rejects. A poster missing from the result could not be resolved this time.
    async function resolvePosters(guildId: string, userIds: string[]): Promise<Map<string, Poster>> {
        const result = new Map<string, Poster>();
        const unknown: string[] = [];
        for(const userId of new Set(userIds)) {
            const cached = posterCache.get(`${guildId}:${userId}`);
            if(cached && cached.expiresAt > now()) result.set(userId, cached.poster);
            else unknown.push(userId);
        }
        if(!unknown.length) return result;
        try {
            const resolved = await discord.resolvePosters(guildId, unknown);
            for(const userId of unknown) {
                // Not looked up this time: not cached, so the next request asks again.
                if(!resolved.has(userId)) continue;
                const found = resolved.get(userId);
                const poster: Poster = {
                    name: typeof found?.name === "string" && found.name.length ? found.name : null,
                    avatarUrl: typeof found?.avatarUrl === "string" && found.avatarUrl.startsWith("https://") ? found.avatarUrl : null
                };
                result.set(userId, poster);
                setBounded(posterCache, `${guildId}:${userId}`, {poster, expiresAt: now() + POSTER_TTL_MS});
            }
        } catch(e) {
            log.error(`Internal API: unable to resolve poster names in guild ${guildId}.`, e);
        }
        return result;
    }

    async function resolveDisplayUrls(urls: string[]): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        const stale: string[] = [];
        for(const url of urls) {
            result.set(url, url);
            if(!isDiscordCdnUrl(url)) continue;
            // A recently posted attachment is still validly signed as stored.
            const ownExpiry = parseCdnExpiry(url);
            if(ownExpiry !== null && ownExpiry - REFRESH_MARGIN_MS > now()) continue;
            const cached = refreshCache.get(url);
            if(cached && cached.expiresAt > now()) {
                result.set(url, cached.displayUrl);
            } else if(!stale.includes(url)) {
                stale.push(url);
            }
        }
        for(let i = 0; i < stale.length; i += REFRESH_BATCH_SIZE) {
            const batch = stale.slice(i, i + REFRESH_BATCH_SIZE);
            try {
                const refreshed = await discord.refreshUrls(batch);
                for(const entry of refreshed) {
                    if(!batch.includes(entry?.original) || typeof entry.refreshed !== "string" || !entry.refreshed.startsWith("https://")) continue;
                    result.set(entry.original, entry.refreshed);
                    const expiry = parseCdnExpiry(entry.refreshed);
                    if(expiry !== null && expiry - REFRESH_MARGIN_MS > now()) {
                        setBounded(refreshCache, entry.original, {displayUrl: entry.refreshed, expiresAt: expiry - REFRESH_MARGIN_MS}, MAX_REFRESH_CACHE_ENTRIES);
                    }
                }
            } catch(e) {
                log.error("Internal API: unable to refresh attachment URLs.", e);
            }
        }
        return result;
    }

    // userId is read for the pool's mine and canDelete. toSubmissions builds each
    // item field by field, so it cannot reach a response.
    const SUBMISSION_COLUMNS = "CAST(id AS CHAR) AS id, url, DATE_FORMAT(createdAt, '%Y-%m-%dT%H:%i:%sZ') AS createdAt, source, channelId, messageId, userId";

    // One item per row, in the order of rows.
    async function toSubmissions(rows: any[], category: Category, guildId: string): Promise<Submission[]> {
        const displayUrls = await resolveDisplayUrls(rows.map(row => String(row.url)));
        return rows.map(row => {
            const url = String(row.url);
            return {
                id: String(row.id),
                category,
                url,
                displayUrl: displayUrls.get(url) || url,
                createdAt: row.createdAt === null || row.createdAt === undefined ? null : String(row.createdAt),
                source: row.source === "web" ? "web" : "discord",
                messageUrl: messageUrlOf(guildId, row.channelId, row.messageId)
            };
        });
    }

    async function listGuilds(userId: string) {
        const entries = await Promise.all(Object.entries(config.guilds).map(async ([key, guild]) => {
            if(!guild?.guildId) return null;
            const access = await getAccess(guild, userId);
            if(!access.member) return null;
            const info = await discord.getGuildInfo(guild.guildId);
            // A configured guild the bot is not in (or cannot see yet) is omitted.
            if(!info) return null;
            return {
                guildId: guild.guildId,
                key,
                name: info.name,
                iconUrl: info.iconUrl,
                categories: CATEGORIES.filter(category => channelsFor(guild, category).length > 0),
                canModerate: access.moderator
            };
        }));
        return {guilds: entries.filter(entry => entry !== null)};
    }

    // The listing and the pool are one query; only the scope differs: the
    // asker's own rows, or every row of the guild. Both check membership first.
    async function listPage(guildId: string, params: URLSearchParams, scope: "own"|"pool") {
        const userId = parseDiscordId(params.get("userId"), "userId");
        const category = parseCategory(params.get("category"));
        let limit = MAX_LIMIT;
        const rawLimit = params.get("limit");
        if(rawLimit !== null) {
            if(!/^[0-9]{1,2}$/.test(rawLimit)) throw invalid(`limit must be between 1 and ${MAX_LIMIT}.`);
            limit = parseInt(rawLimit, 10);
            if(limit < 1 || limit > MAX_LIMIT) throw invalid(`limit must be between 1 and ${MAX_LIMIT}.`);
        }
        let cursor: {createdAt: string|null, id: string}|null = null;
        const rawCursor = params.get("cursor");
        if(rawCursor !== null) {
            cursor = decodeCursor(rawCursor);
            if(!cursor) throw invalid("cursor is not valid.");
        }
        const {guild} = getGuild(guildId);
        const access = await requireMember(guild, userId);

        const table = tableFor(category);
        const scopeWhere = scope === "own" ? "guildId = ? AND userId = ?" : "guildId = ?";
        const scopeValues: unknown[] = scope === "own" ? [guildId, userId] : [guildId];
        let where = scopeWhere;
        const values: unknown[] = [...scopeValues];
        if(cursor && cursor.createdAt !== null) {
            const createdAt = cursor.createdAt.replace("T", " ").replace("Z", "");
            where += " AND (createdAt < ? OR (createdAt = ? AND id < CAST(? AS UNSIGNED)) OR createdAt IS NULL)";
            values.push(createdAt, createdAt, cursor.id);
        } else if(cursor) {
            where += " AND createdAt IS NULL AND id < CAST(? AS UNSIGNED)";
            values.push(cursor.id);
        }
        // MariaDB sorts NULL lowest, so DESC already puts unknown dates last.
        const rows: any[] = await query(`SELECT ${SUBMISSION_COLUMNS} FROM ${table} WHERE ${where} ORDER BY createdAt DESC, id DESC LIMIT ?`, [...values, limit + 1]);
        const counted = await query(`SELECT COUNT(*) AS total FROM ${table} WHERE ${scopeWhere}`, scopeValues);
        const page = rows.slice(0, limit);
        const items = await toSubmissions(page, category, guildId);
        const last = items[items.length - 1];
        return {
            userId, access, page, items,
            nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
            total: Number(counted?.[0]?.total ?? 0)
        };
    }

    async function listSubmissions(guildId: string, params: URLSearchParams) {
        const {items, nextCursor, total} = await listPage(guildId, params, "own");
        return {items, nextCursor, total};
    }

    async function listPool(guildId: string, params: URLSearchParams) {
        const {userId, access, page, items, nextCursor, total} = await listPage(guildId, params, "pool");
        const posterOf = (row: any): string|null => typeof row.userId === "string" && DISCORD_ID.test(row.userId) ? row.userId : null;
        const posters = await resolvePosters(guildId, page.map(posterOf).filter((id): id is string => id !== null));
        const poolItems: PoolItem[] = items.map((item, index) => {
            const posterId = posterOf(page[index]);
            const mine = posterId !== null && posterId === userId;
            // The poster's id decides these three fields and goes no further.
            return {
                ...item,
                poster: (posterId !== null && posters.get(posterId)) || {name: null, avatarUrl: null},
                mine,
                canDelete: mine || access.moderator
            };
        });
        return {items: poolItems, nextCursor, total};
    }

    async function addSubmission(guildId: string, body: unknown) {
        if(typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("The body must be a JSON object.");
        const fields = body as Record<string, unknown>;
        const userId = parseDiscordId(fields.userId, "userId");
        const category = parseCategory(fields.category);
        const urlProblem = validateSubmissionUrl(fields.url);
        if(urlProblem) throw invalid(urlProblem);
        const url = fields.url as string;
        const {guild} = getGuild(guildId);
        await requireMember(guild, userId);
        // The notice keeps mods informed, so a category without a configured channel
        // cannot take web submissions: 404, the same as an unsupported guild.
        const noticeChannel = channelsFor(guild, category)[0];
        if(!noticeChannel) throw notFound("That category is not enabled for this guild.");

        const table = tableFor(category);
        // saveAttachments keeps every submitter in users; do the same here.
        await query("INSERT IGNORE INTO users (id, guildId) VALUES (?, ?)", [userId, guildId]);
        let inserted;
        try {
            inserted = await query(`INSERT INTO ${table} (url, guildId, userId, createdAt, source) VALUES (?, ?, ?, UTC_TIMESTAMP(), 'web')`, [url, guildId, userId]);
        } catch(e: any) {
            // Either unique key: the same URL (ascii_bin, so exact and case-sensitive:
            // /A.png and /a.png are two images), or the same mediaKey, which is how a
            // Discord attachment under another signature or host is still a duplicate.
            if(e?.errno === ER_DUP_ENTRY || e?.code === "ER_DUP_ENTRY") {
                throw new ApiError(409, "DUPLICATE", "That URL is already stored for this guild.");
            }
            throw e;
        }
        const rows: any[] = await query(`SELECT ${SUBMISSION_COLUMNS} FROM ${table} WHERE id = CAST(? AS UNSIGNED)`, [String(inserted.insertId)]);
        if(!rows?.length) throw new Error("The inserted row could not be read back.");
        const [item] = await toSubmissions(rows, category, guildId);
        try {
            await discord.postNotice(noticeChannel, formatWebAddNotice(userId, url));
        } catch(e) {
            log.error(`Internal API: unable to post the web-add notice in channel ${noticeChannel}.`, e);
        }
        return {item};
    }

    async function deleteSubmission(guildId: string, rawCategory: string, rawId: string, params: URLSearchParams) {
        const category = parseCategory(rawCategory);
        if(!ROW_ID.test(rawId)) throw invalid("id is not a valid row id.");
        const userId = parseDiscordId(params.get("userId"), "userId");
        const {guild} = getGuild(guildId);
        const access = await requireMember(guild, userId);

        const table = tableFor(category);
        const existing: any[] = await query(`SELECT userId, channelId, messageId FROM ${table} WHERE id = CAST(? AS UNSIGNED) AND guildId = ?`, [rawId, guildId]);
        if(!existing?.length) throw notFound("No such submission.");
        const mine = typeof existing[0].userId === "string" && existing[0].userId === userId;
        if(!mine && !access.moderator) {
            throw new ApiError(403, "FORBIDDEN", "Only the poster, a moderator of the guild or the owner can remove this submission.");
        }
        // Always scoped to the id and the guild, and to the asker as well when
        // being the poster is the asker's only claim to the row.
        const where = "t.id = CAST(? AS UNSIGNED) AND t.guildId = ?" + (access.moderator ? "" : " AND t.userId = ?");
        const values = access.moderator ? [rawId, guildId] : [rawId, guildId, userId];
        // DELETE erases the row: a removal a person asked for keeps no copy
        // anywhere, and a moderator or the owner is a person like any other
        // (the policy is in util/imageRemoval.ts).
        const removed = await transaction((inTransaction) => removeRows(inTransaction, table, "removed_on_site", where, values));
        // Someone else removed it between the two statements.
        if(!removed) throw notFound("No such submission.");

        const channelId = existing?.[0]?.channelId;
        const messageId = existing?.[0]?.messageId;
        if(channelId && messageId) {
            try {
                const remaining = await query(`SELECT COUNT(*) AS total FROM ${table} WHERE guildId = ? AND messageId = ?`, [guildId, messageId]);
                if(!Number(remaining?.[0]?.total ?? 0)) await discord.removeCameraReaction(String(channelId), String(messageId));
            } catch(e) {
                log.error(`Internal API: unable to clear the camera reaction on message ${messageId}.`, e);
            }
        }
        return {deleted: true};
    }

    function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const tooLarge = () => new ApiError(413, "PAYLOAD_TOO_LARGE", `The body must be at most ${MAX_BODY_BYTES} bytes.`);
            if(Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
                reject(tooLarge());
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            const onData = (chunk: Buffer) => {
                size += chunk.length;
                if(size > MAX_BODY_BYTES) {
                    req.off("data", onData);
                    reject(tooLarge());
                    return;
                }
                chunks.push(chunk);
            };
            req.on("data", onData);
            req.on("end", () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                } catch(e) {
                    reject(invalid("The body is not valid JSON."));
                }
            });
            req.on("error", reject);
        });
    }

    function send(res: http.ServerResponse, status: number, body: unknown, close: boolean = false) {
        if(res.headersSent) return;
        // The driver returns BIGINT and COUNT(*) as BigInt, which JSON.stringify rejects.
        const payload = Buffer.from(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value), "utf8");
        const headers: http.OutgoingHttpHeaders = {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": payload.length,
            "Cache-Control": "no-store"
        };
        if(close) headers["Connection"] = "close";
        res.writeHead(status, headers);
        res.end(payload);
    }

    async function route(req: http.IncomingMessage): Promise<{status: number, body: unknown}> {
        let url: URL;
        try {
            url = new URL(req.url || "/", "http://internal");
        } catch(e) {
            throw invalid("The request URL is malformed.");
        }
        const method = req.method || "GET";
        const segments = url.pathname.split("/").slice(1);
        if(method === "GET" && url.pathname === "/v1/health") {
            return {status: 200, body: {status: "ok", discordReady: discord.isReady()}};
        }
        if(!isAuthorized(req.headers.authorization)) {
            throw new ApiError(401, "UNAUTHORIZED", "Missing or wrong bearer key.");
        }
        if(segments[0] !== "v1") throw notFound();
        const notReady = () => new ApiError(503, "NOT_READY", "The Discord client is not connected yet.");

        if(segments.length === 4 && segments[1] === "users" && segments[3] === "guilds" && method === "GET") {
            const userId = parseDiscordId(segments[2], "userId");
            if(!discord.isReady()) throw notReady();
            return {status: 200, body: await listGuilds(userId)};
        }
        if(segments.length === 4 && segments[1] === "guilds" && segments[3] === "pool" && method === "GET") {
            const guildId = parseDiscordId(segments[2], "guildId");
            if(!discord.isReady()) throw notReady();
            return {status: 200, body: await listPool(guildId, url.searchParams)};
        }
        if(segments[1] === "guilds" && segments[3] === "submissions") {
            if(segments.length === 4 && method === "GET") {
                const guildId = parseDiscordId(segments[2], "guildId");
                if(!discord.isReady()) throw notReady();
                return {status: 200, body: await listSubmissions(guildId, url.searchParams)};
            }
            if(segments.length === 4 && method === "POST") {
                const guildId = parseDiscordId(segments[2], "guildId");
                const body = await readJsonBody(req);
                if(!discord.isReady()) throw notReady();
                return {status: 201, body: await addSubmission(guildId, body)};
            }
            if(segments.length === 6 && method === "DELETE") {
                const guildId = parseDiscordId(segments[2], "guildId");
                if(!discord.isReady()) throw notReady();
                return {status: 200, body: await deleteSubmission(guildId, segments[4], segments[5], url.searchParams)};
            }
        }
        throw notFound();
    }

    return http.createServer((req, res) => {
        route(req).then(({status, body}) => send(res, status, body)).catch((e) => {
            if(e instanceof ApiError) {
                // After a 413 the rest of the body is unread, so the connection cannot be reused.
                if(e.status === 413) req.resume();
                send(res, e.status, {error: {code: e.code, message: e.message}}, e.status === 413);
                return;
            }
            log.error(`Internal API: ${req.method} ${(req.url || "").split("?")[0]} failed.`, e);
            send(res, 500, {error: {code: "INTERNAL", message: "Internal error."}});
        });
    });
}

export function createDiscordFacade(client: Client): DiscordFacade {
    return {
        isReady: () => client.isReady(),
        async memberRoles(guildId, userId) {
            const guild = client.guilds.cache.get(guildId);
            if(!guild) return null;
            try {
                // force: without the GuildMembers intent the member cache never learns
                // that someone left or lost a role, so a cached member proves nothing.
                const member = await guild.members.fetch({user: userId, force: true, cache: false});
                // Names come from the guild's role cache, which the Guilds intent keeps current.
                return member.roles.cache.map(role => role.name);
            } catch(e: any) {
                if(NOT_A_MEMBER_CODES.includes(e?.code)) return null;
                throw e;
            }
        },
        async resolvePosters(guildId, userIds) {
            const result = new Map<string, Poster|null>();
            const guild = client.guilds.cache.get(guildId);
            if(!guild || !userIds.length) return result;
            const absent: string[] = [];
            for(let i = 0; i < userIds.length; i += MEMBER_CHUNK_SIZE) {
                const chunk = userIds.slice(i, i + MEMBER_CHUNK_SIZE);
                const cachedBefore = new Set(chunk.filter(id => guild.members.cache.has(id)));
                let members;
                try {
                    // One gateway request (Request Guild Members by user id) for the whole
                    // chunk. Explicit ids need no privileged intent; only listing a guild does.
                    members = await guild.members.fetch({user: chunk, time: MEMBER_CHUNK_TIMEOUT_MS});
                } catch(e) {
                    // Who is still in the guild is unknown, so nobody of this chunk is
                    // answered (or cached) and the next request asks again.
                    console.error(`Internal API: the member request for ${chunk.length} posters in guild ${guildId} failed.`, e);
                    continue;
                }
                for(const id of chunk) {
                    const member = members.get(id);
                    if(!member) {
                        absent.push(id);
                        continue;
                    }
                    result.set(id, {name: member.displayName, avatarUrl: member.avatarURL({size: AVATAR_SIZE}) ?? member.user.avatarURL({size: AVATAR_SIZE})});
                    // A chunk lands in the member cache, where nothing would ever update
                    // it without the GuildMembers intent, and the reaction handlers read
                    // roles from that cache. Leave it the way it was.
                    if(!cachedBefore.has(id)) guild.members.cache.delete(id);
                }
            }
            // People who left the guild: their global name. Bounded, because each is
            // a REST call; the rest stay unanswered until a later request.
            for(const id of absent.slice(0, MAX_USER_FETCHES)) {
                try {
                    const user = await client.users.fetch(id, {cache: false});
                    result.set(id, {name: user.displayName, avatarUrl: user.avatarURL({size: AVATAR_SIZE})});
                } catch(e: any) {
                    if(e?.code === UNKNOWN_USER) result.set(id, null);
                    else console.error(`Internal API: unable to fetch user ${id}.`, e);
                }
            }
            return result;
        },
        async getGuildInfo(guildId) {
            const guild = client.guilds.cache.get(guildId);
            if(!guild) return null;
            return {name: guild.name, iconUrl: guild.iconURL({size: 128})};
        },
        async refreshUrls(urls) {
            const response = await client.rest.post("/attachments/refresh-urls", {body: {attachment_urls: urls}}) as {refreshed_urls?: RefreshedUrl[]};
            return Array.isArray(response?.refreshed_urls) ? response.refreshed_urls : [];
        },
        async postNotice(channelId, content) {
            const channel = await client.channels.fetch(channelId);
            if(!channel || !channel.isSendable()) throw new Error(`Channel ${channelId} cannot be sent to.`);
            await channel.send({content, allowedMentions: {parse: []}});
        },
        async removeCameraReaction(channelId, messageId) {
            await client.rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(CAMERA)));
        }
    };
}

export interface StartInternalApiOptions {
    client: Client;
    query: QueryFn;
    transaction: TransactionFn;
    env?: NodeJS.ProcessEnv;
    log?: Logger;
}

// Returns null, after one warning, when the API is not configured. The bot
// itself must keep working without it.
export function startInternalApi(options: StartInternalApiOptions): http.Server|null {
    const env = options.env || process.env;
    const log: Logger = options.log || console;
    const key = env.INTERNAL_API_KEY || "";
    if(key.length < MIN_KEY_LENGTH) {
        log.warn(`Internal API disabled: INTERNAL_API_KEY is unset or shorter than ${MIN_KEY_LENGTH} characters.`);
        return null;
    }
    let guilds: GuildDictionary;
    try {
        guilds = JSON.parse(env.GUILDS || "{}");
    } catch(e) {
        log.warn("Internal API disabled: GUILDS is not valid JSON.");
        return null;
    }
    let port = DEFAULT_PORT;
    if(env.INTERNAL_API_PORT) {
        const parsed = /^[0-9]{1,5}$/.test(env.INTERNAL_API_PORT) ? parseInt(env.INTERNAL_API_PORT, 10) : 0;
        if(parsed >= 1 && parsed <= 65535) port = parsed;
        else log.warn(`INTERNAL_API_PORT is not a valid port; using ${DEFAULT_PORT}.`);
    }
    const owner = parseOwnerUserId(env.OWNER_USER_ID);
    if(owner.invalid) log.warn("OWNER_USER_ID is not a valid Discord id; nobody is the owner.");
    const server = createInternalApi({
        config: {key, guilds, ownerUserId: owner.ownerUserId},
        query: options.query,
        transaction: options.transaction,
        discord: createDiscordFacade(options.client),
        log
    });
    // A port conflict must not take the bot down with it.
    server.on("error", (e) => log.error("Internal API server error:", e));
    server.listen(port, "0.0.0.0", () => log.info(`Internal API listening on port ${port}.`));
    return server;
}
