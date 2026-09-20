// Reaction counts of the Discord message each row came from, for the site's
// leaderboards (contract: cantus.dev/docs/geoffrey-internal-api.md, "Reaction
// counts"). Two counts per row: reactions with any emoji, and camera-flash
// reactions, both without the bot's own reaction.
//
// Kept current two ways, both in this file:
// - A recounter that the reaction events in index.ts feed. A reaction added or
//   removed on a message in a collected channel fetches that message once, a
//   moment later so a burst is one request, and writes its counts on every row
//   of the message.
// - A background job like backfillOrigins.ts: rows that were never counted, then
//   rows counted more than 30 days ago, one message request at a time, seconds
//   apart. Set REACTION_COUNTS=off to keep it from starting.
//
// Both only ever UPDATE reactionCount, flashCount and reactionsCheckedAt, by
// guildId and messageId. Nothing here inserts or deletes.
import { Client, Routes } from "discord.js";
import { QueryFn } from "../util/imageRemoval";
import { getTableByCommandName } from "../util/tables";
import type { GuildDictionary } from "../util/util";

export const CAMERA_FLASH = "\u{1F4F8}";
// A burst of reactions on one message becomes one fetch.
export const RECOUNT_DELAY_MS = 2_000;
export const MAX_PENDING_RECOUNTS = 1_000;

export const LOOKUP_INTERVAL_MS = 2_000;
export const MAX_LOOKUPS_PER_RUN = 25;
export const SCAN_LIMIT = 500;
export const FIRST_RUN_DELAY_MS = 90_000;
// 25 requests two seconds apart every 90 seconds is about 640 messages an hour,
// so a collection of 6,000 posts is counted in about ten hours.
export const BUSY_DELAY_MS = 90_000;
export const IDLE_DELAY_MS = 60 * 60_000;
export const ERROR_DELAY_MS = 15 * 60_000;
export const RECHECK_AFTER_DAYS = 30;
// Unknown Message, Unknown Channel, Missing Access: the message cannot be counted.
const GONE_CODES = [10008, 10003, 50001];
const SNOWFLAKE = /^[0-9]{5,25}$/;

// What Discord's message object carries per emoji.
export interface FetchedReaction {
    count?: unknown,
    me?: unknown,
    emoji?: {name?: unknown}|null
}

export interface FetchedMessage {
    id?: unknown,
    reactions?: FetchedReaction[]
}

export interface ReactionCounts {
    reactionCount: number,
    flashCount: number
}

type Logger = Pick<Console, "info"|"warn"|"error">;

function tables(): string[] {
    return [getTableByCommandName("homies"), getTableByCommandName("pets")].filter((table): table is string => !!table);
}

const affected = (result: any) => Number(result?.affectedRows ?? 0);

// The bot's own reaction is one of the `count` when `me` is set, and it is not
// a person's opinion of the post, so it comes off. A super reaction is a
// reaction: Discord's count already includes it once.
export function countReactions(reactions: unknown): ReactionCounts {
    const counts: ReactionCounts = {reactionCount: 0, flashCount: 0};
    if(!Array.isArray(reactions)) return counts;
    for(const reaction of reactions as FetchedReaction[]) {
        const count = typeof reaction?.count === "number" && Number.isFinite(reaction.count) ? Math.max(0, Math.floor(reaction.count)) : 0;
        const others = Math.max(0, count - (reaction?.me === true ? 1 : 0));
        counts.reactionCount += others;
        if(reaction?.emoji?.name === CAMERA_FLASH) counts.flashCount += others;
    }
    return counts;
}

// Writes the counts on every row of the message, in both tables. Returns the
// number of rows written.
export async function recordReactionCounts(query: QueryFn, guildId: string, messageId: string, counts: ReactionCounts): Promise<number> {
    let written = 0;
    for(const table of tables()) {
        written += affected(await query(`UPDATE ${table} SET reactionCount = ?, flashCount = ?, reactionsCheckedAt = UTC_TIMESTAMP() WHERE guildId = ? AND messageId = ?`, [counts.reactionCount, counts.flashCount, guildId, messageId]));
    }
    return written;
}

// Stamps the rows of a message that could not be fetched, keeping whatever
// counts they had, so the job moves on and comes back to them in 30 days.
async function markChecked(query: QueryFn, guildId: string, messageId: string): Promise<number> {
    let written = 0;
    for(const table of tables()) {
        written += affected(await query(`UPDATE ${table} SET reactionsCheckedAt = UTC_TIMESTAMP() WHERE guildId = ? AND messageId = ?`, [guildId, messageId]));
    }
    return written;
}

async function hasRowsForMessage(query: QueryFn, guildId: string, messageId: string): Promise<boolean> {
    for(const table of tables()) {
        const counted = await query(`SELECT COUNT(*) AS total FROM ${table} WHERE guildId = ? AND messageId = ?`, [guildId, messageId]);
        if(Number(counted?.[0]?.total ?? 0) > 0) return true;
    }
    return false;
}

export function isGoneError(e: any): boolean {
    return GONE_CODES.includes(e?.code);
}

// The channels whose messages have rows, per guild, from the GUILDS config.
export function collectedChannelsOf(guilds: GuildDictionary): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for(const guild of Object.values(guilds || {})) {
        if(typeof guild?.guildId !== "string") continue;
        const channels = new Set<string>();
        for(const list of [guild.channels?.homies, guild.channels?.pets]) {
            for(const channelId of Array.isArray(list) ? list : []) {
                if(typeof channelId === "string") channels.add(channelId);
            }
        }
        result.set(guild.guildId, channels);
    }
    return result;
}

export interface RecounterDeps {
    query: QueryFn;
    guilds: GuildDictionary;
    // GET /channels/:channelId/messages/:messageId. Rejects with Discord's error
    // (its `code` is looked at) when the request fails.
    fetchMessage(channelId: string, messageId: string): Promise<FetchedMessage>;
    log?: Logger;
    delayMs?: number;
    // For tests: a timer that can be driven by hand.
    setTimer?(callback: () => void, ms: number): unknown;
}

export interface MessageRef {
    guildId: unknown,
    channelId: unknown,
    id: unknown
}

export interface Recounter {
    // A reaction changed on this message. Returns true when a recount was
    // scheduled, false when the message is not one the bot collects from.
    noticed(message: MessageRef): boolean;
    // Fetches and records one message's counts now. Resolves to the number of
    // rows written, 0 when nothing is stored for it, or when it could not be fetched.
    recount(guildId: string, channelId: string, messageId: string): Promise<number>;
    pending(): number;
}

export function createRecounter(deps: RecounterDeps): Recounter {
    const log: Logger = deps.log || console;
    const delayMs = deps.delayMs ?? RECOUNT_DELAY_MS;
    const setTimer = deps.setTimer || ((callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; });
    const collected = collectedChannelsOf(deps.guilds);
    const scheduled = new Set<string>();

    async function recount(guildId: string, channelId: string, messageId: string): Promise<number> {
        // A reaction on a plain text message in the channel is not worth a request.
        if(!await hasRowsForMessage(deps.query, guildId, messageId)) return 0;
        let message: FetchedMessage;
        try {
            message = await deps.fetchMessage(channelId, messageId);
        } catch(e: any) {
            if(isGoneError(e)) return 0;
            throw e;
        }
        return await recordReactionCounts(deps.query, guildId, messageId, countReactions(message?.reactions));
    }

    return {
        noticed(message) {
            const {guildId, channelId, id} = message;
            if(typeof guildId !== "string" || typeof channelId !== "string" || typeof id !== "string") return false;
            if(!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(id)) return false;
            if(!collected.get(guildId)?.has(channelId)) return false;
            const key = `${guildId}/${channelId}/${id}`;
            if(scheduled.has(key)) return true;
            // A flood of reactions on many messages must not grow without bound;
            // the background job catches up with anything dropped here.
            if(scheduled.size >= MAX_PENDING_RECOUNTS) {
                log.warn(`Reaction recounts: ${scheduled.size} pending; leaving message ${id} to the background job.`);
                return false;
            }
            scheduled.add(key);
            setTimer(() => {
                scheduled.delete(key);
                recount(guildId, channelId, id).catch(e => log.error(`Reaction recounts: unable to count message ${id} in channel ${channelId}.`, e));
            }, delayMs);
            return true;
        },
        recount,
        pending: () => scheduled.size
    };
}

// The background job.

export interface CountJobDeps {
    query: QueryFn;
    fetchMessage(channelId: string, messageId: string): Promise<FetchedMessage>;
    sleep(ms: number): Promise<void>;
}

export interface CountJobOptions {
    maxLookups: number,
    scanLimit: number,
    intervalMs: number
}

export const DEFAULT_OPTIONS: CountJobOptions = {maxLookups: MAX_LOOKUPS_PER_RUN, scanLimit: SCAN_LIMIT, intervalMs: LOOKUP_INTERVAL_MS};

export interface CountJobSummary {
    pending: number,     // rows read this run
    lookups: number,     // message requests made
    counted: number,     // rows that got counts
    gone: number,        // messages that could not be fetched; their rows are stamped
    more: boolean,       // pending rows remain for the next run
    stopped: string|null // the error that ended the run early
}

interface PendingRow {
    guildId: string,
    channelId: string,
    messageId: string
}

// Never counted first, then the longest ago, so a fresh backlog is cleared
// before anything is checked a second time.
const PENDING = `messageId IS NOT NULL AND channelId IS NOT NULL AND (reactionsCheckedAt IS NULL OR reactionsCheckedAt < UTC_TIMESTAMP() - INTERVAL ${RECHECK_AFTER_DAYS} DAY)`;

export async function countPendingReactions(deps: CountJobDeps, options: CountJobOptions = DEFAULT_OPTIONS): Promise<CountJobSummary> {
    const {query} = deps;
    const summary: CountJobSummary = {pending: 0, lookups: 0, counted: 0, gone: 0, more: false, stopped: null};
    try {
        // One request settles every row of a message, and a message's rows are
        // in one table, so the tables are read in turn and merged by message.
        const messages = new Map<string, PendingRow>();
        for(const table of tables()) {
            const rows: any[] = await query(`SELECT guildId, channelId, messageId FROM ${table} WHERE ${PENDING} ORDER BY reactionsCheckedAt IS NOT NULL, reactionsCheckedAt, id LIMIT ?`, [options.scanLimit]);
            summary.pending += rows.length;
            if(rows.length >= options.scanLimit) summary.more = true;
            for(const row of rows) {
                const key = `${row.guildId}/${row.channelId}/${row.messageId}`;
                if(!messages.has(key)) messages.set(key, {guildId: String(row.guildId), channelId: String(row.channelId), messageId: String(row.messageId)});
            }
        }
        for(const row of messages.values()) {
            if(summary.lookups >= options.maxLookups) {
                summary.more = true;
                break;
            }
            if(!SNOWFLAKE.test(row.channelId) || !SNOWFLAKE.test(row.messageId)) {
                // Not something to send to Discord; stamped so it is not read every run.
                await markChecked(query, row.guildId, row.messageId);
                summary.gone++;
                continue;
            }
            if(summary.lookups > 0) await deps.sleep(options.intervalMs);
            summary.lookups++;
            let message: FetchedMessage;
            try {
                message = await deps.fetchMessage(row.channelId, row.messageId);
            } catch(e: any) {
                if(isGoneError(e)) {
                    await markChecked(query, row.guildId, row.messageId);
                    summary.gone++;
                    continue;
                }
                // Rate limits, outages, anything unexpected: nothing is known, so nothing is written.
                throw e;
            }
            summary.counted += await recordReactionCounts(query, row.guildId, row.messageId, countReactions(message?.reactions));
        }
    } catch(e: any) {
        summary.stopped = String(e?.message || e);
        summary.more = true;
    }
    return summary;
}

export function formatSummary(summary: CountJobSummary): string {
    const parts = [`${summary.pending} pending read`, `${summary.lookups} message request(s)`, `${summary.counted} row(s) counted`, `${summary.gone} message(s) gone`];
    const ending = summary.stopped ? `stopped early: ${summary.stopped}` : summary.more ? "more remain" : "backlog done";
    return `Reaction counts: ${parts.join(", ")}; ${ending}.`;
}

export function nextDelay(summary: CountJobSummary): number {
    if(summary.stopped) return ERROR_DELAY_MS;
    return summary.more ? BUSY_DELAY_MS : IDLE_DELAY_MS;
}

export interface StartReactionCountsOptions {
    client: Client;
    query: QueryFn;
    guilds: GuildDictionary;
    env?: NodeJS.ProcessEnv;
    log?: Logger;
}

export interface ReactionCountsHandle {
    recounter: Recounter;
    stop(): void;
}

// Through the client's REST manager, which queues per route and waits out 429s
// itself. Not channel.messages.fetch: that would cache every message.
function fetchMessageWith(client: Client) {
    return async (channelId: string, messageId: string): Promise<FetchedMessage> => {
        return await client.rest.get(Routes.channelMessage(channelId, messageId)) as FetchedMessage;
    };
}

// The recounter for the reaction events, and the job on a timer. Runs of the
// job never overlap: the next one is scheduled when the last one has ended.
// The timers are unref'ed, so they never keep the process alive. With
// REACTION_COUNTS=off neither starts, and the events are ignored.
export function startReactionCounts(options: StartReactionCountsOptions): ReactionCountsHandle|null {
    const env = options.env || process.env;
    const log: Logger = options.log || console;
    const {client, query} = options;
    if((env.REACTION_COUNTS || "").trim().toLowerCase() === "off") {
        log.info("Reaction counts are switched off (REACTION_COUNTS=off).");
        return null;
    }
    const fetchMessage = fetchMessageWith(client);
    const recounter = createRecounter({query, guilds: options.guilds, fetchMessage, log});
    let timer: NodeJS.Timeout|null = null;
    let stopped = false;
    const schedule = (ms: number) => {
        if(stopped) return;
        timer = setTimeout(run, ms);
        timer.unref();
    };
    const deps: CountJobDeps = {
        query,
        fetchMessage,
        sleep: (ms) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref(); })
    };
    async function run() {
        let delay = ERROR_DELAY_MS;
        try {
            if(!client.isReady()) {
                delay = FIRST_RUN_DELAY_MS;
                return;
            }
            const summary = await countPendingReactions(deps);
            delay = nextDelay(summary);
            // An idle run (nothing pending) says nothing.
            if(summary.stopped) log.warn(formatSummary(summary));
            else if(summary.pending) log.info(formatSummary(summary));
        } catch(e) {
            log.error("Reaction counts failed.", e);
        } finally {
            schedule(delay);
        }
    }
    schedule(FIRST_RUN_DELAY_MS);
    return {
        recounter,
        stop() {
            stopped = true;
            if(timer) clearTimeout(timer);
        }
    };
}
