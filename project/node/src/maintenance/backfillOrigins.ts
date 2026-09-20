// Finds the Discord message that rows from before the channelId and messageId
// columns came from, so the site can link to it (contract: "Original message").
//
// Unlike sweepDeadMedia.ts this runs inside the bot, on a timer that index.ts
// starts: a few channel requests per run, seconds apart, through the client's
// own REST queue. Set ORIGIN_BACKFILL=off to keep it from starting.
//
// It reads rows and it writes three columns of them: channelId, messageId and
// originCheckedAt. It never inserts and never deletes. Every UPDATE repeats
// `messageId IS NULL AND originCheckedAt IS NULL`, so a row that already knows
// its message, or was already searched, cannot be written again. To search
// everything once more: UPDATE homies SET originCheckedAt = NULL WHERE messageId IS NULL
// (and the same for pets).
import { Client, Routes } from "discord.js";
import { parseDiscordAttachmentUrl, QueryFn } from "../util/imageRemoval";
import { getTableByCommandName } from "../util/tables";

// A message id is minted just after the ids of its attachments, so the message
// is among those around the attachment id; 50 also catches its neighbours,
// which settles the other pending rows of a busy day in the same request.
export const LOOKUP_LIMIT = 50;
export const LOOKUP_INTERVAL_MS = 5_000;
export const MAX_LOOKUPS_PER_RUN = 12;
// Pending rows read per table and run. They are the rows one request can settle.
export const SCAN_LIMIT = 500;
export const FIRST_RUN_DELAY_MS = 60_000;
// Two minutes between runs of twelve lookups is about 240 channel requests an
// hour, far below what Discord allows, and clears the first backlog of about
// 6,400 rows in a day at the very worst instead of two.
export const BUSY_DELAY_MS = 2 * 60_000;
export const IDLE_DELAY_MS = 60 * 60_000;
export const ERROR_DELAY_MS = 15 * 60_000;
// Unknown Channel, Missing Access: asking again row by row would change nothing.
const CHANNEL_CLOSED_CODES = [10003, 50001];
// What the 002 migration accepted as a snowflake, give or take a digit. Anything
// else in a URL is not something to send to Discord as `around`.
const SNOWFLAKE = /^[0-9]{15,20}$/;

const PENDING = "messageId IS NULL AND originCheckedAt IS NULL";

export interface FetchedMessage {
    id?: unknown,
    attachments?: {id?: unknown}[]
}

export interface BackfillDeps {
    query: QueryFn;
    // GET /channels/:channelId/messages?around=&limit=. Rejects with Discord's
    // error (its `code` is looked at) when the request fails.
    fetchAround(channelId: string, around: string, limit: number): Promise<FetchedMessage[]>;
    // The guild a channel belongs to, when the bot knows the channel.
    channelGuildId?(channelId: string): string|null;
    sleep(ms: number): Promise<void>;
}

export interface BackfillOptions {
    maxLookups: number,
    scanLimit: number,
    intervalMs: number
}

export const DEFAULT_OPTIONS: BackfillOptions = {maxLookups: MAX_LOOKUPS_PER_RUN, scanLimit: SCAN_LIMIT, intervalMs: LOOKUP_INTERVAL_MS};

export interface BackfillSummary {
    pending: number,        // rows read this run
    lookups: number,        // channel requests made
    matched: number,        // rows that now know their message
    notFound: number,       // looked up; no message around carries the attachment
    skipped: number,        // added on the site, not a Discord attachment, or another guild's channel
    closedChannels: number, // unknown, inaccessible or unreadable
    closedRows: number,     // rows marked with those channels
    more: boolean,          // pending rows remain for the next run
    stopped: string|null    // the error that ended the run early
}

interface PendingRow {
    table: string,
    id: string,
    guildId: string,
    channelId: string,
    attachmentId: string
}

function tables(): string[] {
    return [getTableByCommandName("homies"), getTableByCommandName("pets")].filter((table): table is string => !!table);
}

const affected = (result: any) => Number(result?.affectedRows ?? 0);

export async function backfillOrigins(deps: BackfillDeps, options: BackfillOptions = DEFAULT_OPTIONS): Promise<BackfillSummary> {
    const {query} = deps;
    const summary: BackfillSummary = {pending: 0, lookups: 0, matched: 0, notFound: 0, skipped: 0, closedChannels: 0, closedRows: 0, more: false, stopped: null};
    const markChecked = (row: {table: string, id: string}) => query(`UPDATE ${row.table} SET originCheckedAt = UTC_TIMESTAMP() WHERE id = CAST(? AS UNSIGNED) AND ${PENDING}`, [row.id]);

    const pending: PendingRow[] = [];
    try {
        for(const table of tables()) {
            // A row added on the site never had a message.
            summary.skipped += affected(await query(`UPDATE ${table} SET originCheckedAt = UTC_TIMESTAMP() WHERE ${PENDING} AND source = 'web'`));
            const rows: any[] = await query(`SELECT CAST(id AS CHAR) AS id, url, guildId FROM ${table} WHERE ${PENDING} ORDER BY id LIMIT ?`, [options.scanLimit]);
            summary.pending += rows.length;
            if(rows.length >= options.scanLimit) summary.more = true;
            for(const found of rows) {
                const row = {table, id: String(found.id), guildId: String(found.guildId)};
                const attachment = parseDiscordAttachmentUrl(String(found.url));
                const usable = attachment && SNOWFLAKE.test(attachment.channelId) && SNOWFLAKE.test(attachment.attachmentId);
                // The same picture stored for a second guild points into the first guild's
                // channel; its message is not this row's message.
                const foreign = usable && (deps.channelGuildId?.(attachment.channelId) ?? row.guildId) !== row.guildId;
                if(!attachment || !usable || foreign) {
                    await markChecked(row);
                    summary.skipped++;
                } else {
                    pending.push({...row, ...attachment});
                }
            }
        }

        const byChannel = new Map<string, PendingRow[]>();
        for(const row of pending) byChannel.set(row.channelId, [...(byChannel.get(row.channelId) || []), row]);
        const settled = new Set<PendingRow>();
        const closed = new Set<string>();
        const closeChannel = async (channelId: string) => {
            closed.add(channelId);
            summary.closedChannels++;
            // Every pending row of the channel, read this run or not, in one statement per table.
            for(const table of tables()) {
                summary.closedRows += affected(await query(`UPDATE ${table} SET originCheckedAt = UTC_TIMESTAMP() WHERE ${PENDING} AND mediaKey LIKE ?`, [`discord:${channelId}/%`]));
            }
        };

        for(const row of pending) {
            if(settled.has(row) || closed.has(row.channelId)) continue;
            if(summary.lookups >= options.maxLookups) {
                summary.more = true;
                break;
            }
            if(summary.lookups > 0) await deps.sleep(options.intervalMs);
            summary.lookups++;
            let messages: FetchedMessage[];
            try {
                messages = await deps.fetchAround(row.channelId, row.attachmentId, LOOKUP_LIMIT);
            } catch(e: any) {
                if(CHANNEL_CLOSED_CODES.includes(e?.code)) {
                    await closeChannel(row.channelId);
                    continue;
                }
                // Rate limits, outages, anything unexpected: nothing is known, so nothing is written.
                throw e;
            }
            if(!Array.isArray(messages)) throw new Error("Discord answered the message lookup with something that is not a list.");
            // A channel with messages around a real attachment id always returns some.
            // None at all means it is empty or the bot may not read its history.
            if(!messages.length) {
                await closeChannel(row.channelId);
                continue;
            }
            const carriedBy = new Map<string, string>();
            for(const message of messages) {
                if(typeof message?.id !== "string" || !SNOWFLAKE.test(message.id)) continue;
                for(const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
                    if(typeof attachment?.id === "string") carriedBy.set(attachment.id, message.id);
                }
            }
            // The request was made for one row and settles every row it happens to answer.
            for(const other of byChannel.get(row.channelId) || []) {
                if(settled.has(other)) continue;
                const messageId = carriedBy.get(other.attachmentId);
                if(messageId) {
                    summary.matched += affected(await query(`UPDATE ${other.table} SET channelId = ?, messageId = ?, originCheckedAt = UTC_TIMESTAMP() WHERE id = CAST(? AS UNSIGNED) AND ${PENDING}`, [other.channelId, messageId, other.id]));
                    settled.add(other);
                } else if(other === row) {
                    await markChecked(other);
                    summary.notFound++;
                    settled.add(other);
                }
            }
        }
    } catch(e: any) {
        summary.stopped = String(e?.message || e);
        summary.more = true;
    }
    return summary;
}

export function formatSummary(summary: BackfillSummary): string {
    const parts = [
        `${summary.pending} pending read`,
        `${summary.lookups} channel request(s)`,
        `${summary.matched} matched`,
        `${summary.notFound} not found`,
        `${summary.skipped} skipped`,
        `${summary.closedChannels} closed channel(s) with ${summary.closedRows} row(s)`
    ];
    const ending = summary.stopped ? `stopped early: ${summary.stopped}` : summary.more ? "more remain" : "backlog done";
    return `Origin backfill: ${parts.join(", ")}; ${ending}.`;
}

export function nextDelay(summary: BackfillSummary): number {
    if(summary.stopped) return ERROR_DELAY_MS;
    return summary.more ? BUSY_DELAY_MS : IDLE_DELAY_MS;
}

type Logger = Pick<Console, "info"|"warn"|"error">;

export interface StartOriginBackfillOptions {
    client: Client;
    query: QueryFn;
    env?: NodeJS.ProcessEnv;
    log?: Logger;
}

// Runs never overlap: the next one is scheduled when the last one has ended.
// The timers are unref'ed, so they never keep the process alive.
export function startOriginBackfill(options: StartOriginBackfillOptions): {stop(): void}|null {
    const env = options.env || process.env;
    const log: Logger = options.log || console;
    const {client, query} = options;
    if((env.ORIGIN_BACKFILL || "").trim().toLowerCase() === "off") {
        log.info("Origin backfill is switched off (ORIGIN_BACKFILL=off).");
        return null;
    }
    let timer: NodeJS.Timeout|null = null;
    let stopped = false;
    const schedule = (ms: number) => {
        if(stopped) return;
        timer = setTimeout(run, ms);
        timer.unref();
    };
    const deps: BackfillDeps = {
        query,
        async fetchAround(channelId, around, limit) {
            // Through the client's REST manager, which queues per route and waits out
            // 429s itself. Not channel.messages.fetch: that would cache every message.
            return await client.rest.get(Routes.channelMessages(channelId), {query: new URLSearchParams({around, limit: String(limit)})}) as FetchedMessage[];
        },
        channelGuildId(channelId) {
            const channel: any = client.channels.cache.get(channelId);
            return typeof channel?.guildId === "string" ? channel.guildId : null;
        },
        sleep: (ms) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref(); })
    };
    async function run() {
        let delay = ERROR_DELAY_MS;
        try {
            if(!client.isReady()) {
                delay = FIRST_RUN_DELAY_MS;
                return;
            }
            const summary = await backfillOrigins(deps);
            delay = nextDelay(summary);
            // An idle run (nothing pending, nothing written) says nothing.
            if(summary.stopped) log.warn(formatSummary(summary));
            else if(summary.pending || summary.skipped) log.info(formatSummary(summary));
        } catch(e) {
            log.error("Origin backfill failed.", e);
        } finally {
            schedule(delay);
        }
    }
    schedule(FIRST_RUN_DELAY_MS);
    return {
        stop() {
            stopped = true;
            if(timer) clearTimeout(timer);
        }
    };
}
