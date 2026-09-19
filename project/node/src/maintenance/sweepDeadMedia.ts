// Finds stored Discord attachments that no longer exist and archives them.
//
//   node /app/maintenance/sweepDeadMedia.js [--apply] [--limit N]
//
// Without --apply nothing is written. It talks to Discord over REST with the
// bot token, not the gateway, so it can run while the bot is online. Nothing in
// the bot imports this file.
//
// A row is only ever archived on positive evidence: the refreshed CDN URL
// answers 404 AND the channel's messages around the attachment id come back
// (HTTP 200) without that attachment. Anything else - other statuses, missing
// access, rate limits, network trouble - leaves the row alone.
import * as mariadb from "mariadb";
import { REST, Routes } from "discord.js";
import { archiveAndDelete, parseDiscordAttachmentUrl } from "../util/imageRemoval";
import { createDbAccess } from "../util/dbAccess";
import { getTableByCommandName } from "../util/tables";

export const REFRESH_BATCH_SIZE = 50;
export const PROBE_CONCURRENCY = 8;
export const LOOKUP_INTERVAL_MS = 400;
// A message id is minted just after the ids of its attachments, so the message
// is among the few around the attachment id.
export const LOOKUP_LIMIT = 11;
const LISTED_CANDIDATES = 20;

export interface SweepRow {
    category: string,
    id: string,
    url: string
}

export type Outcome =
    "not_discord" |       // never touched
    "refresh_failed" |    // Discord gave no fresh URL, so nothing is known
    "alive" |
    "probe_inconclusive" |// the CDN answered neither 2xx nor 404
    "still_posted" |      // 404, but a message still carries the attachment
    "unconfirmed" |       // 404, but the channel could not be read
    "dead";

export interface MessageLookup {
    status: number,
    messages: {attachments?: {id?: string}[]}[]
}

export interface SweepDeps {
    listRows(limit: number|null): Promise<SweepRow[]>;
    refreshUrls(urls: string[]): Promise<{original: string, refreshed: string}[]>;
    // HTTP status of GET with Range: bytes=0-0, or 0 when there was no answer.
    probe(url: string): Promise<number>;
    lookupMessages(channelId: string, attachmentId: string): Promise<MessageLookup>;
    archive(row: SweepRow): Promise<number>;
    sleep(ms: number): Promise<void>;
    log(line: string): void;
}

export interface SweepSummary {
    apply: boolean,
    checked: number,
    counts: Record<string, Record<string, number>>,
    dead: SweepRow[],
    archived: number
}

export function classifyProbe(status: number): "alive"|"candidate"|"probe_inconclusive" {
    if(status === 404) return "candidate";
    return status >= 200 && status < 300 ? "alive" : "probe_inconclusive";
}

export function confirmDead(lookup: MessageLookup, attachmentId: string): "dead"|"still_posted"|"unconfirmed" {
    if(lookup.status !== 200 || !Array.isArray(lookup.messages)) return "unconfirmed";
    const posted = lookup.messages.some(message => (message?.attachments || []).some(attachment => attachment?.id === attachmentId));
    return posted ? "still_posted" : "dead";
}

async function inParallel<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
    let next = 0;
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while(next < items.length) await work(items[next++]);
    });
    await Promise.all(workers);
}

export async function sweep(deps: SweepDeps, options: {apply: boolean, limit: number|null}): Promise<SweepSummary> {
    const rows = await deps.listRows(options.limit);
    const summary: SweepSummary = {apply: options.apply, checked: rows.length, counts: {}, dead: [], archived: 0};
    const record = (row: SweepRow, outcome: Outcome) => {
        const counts = summary.counts[row.category] || (summary.counts[row.category] = {});
        counts[outcome] = (counts[outcome] || 0) + 1;
        if(outcome === "dead") summary.dead.push(row);
    };

    const discordRows = rows.filter(row => {
        if(parseDiscordAttachmentUrl(row.url)) return true;
        record(row, "not_discord");
        return false;
    });
    const candidates: SweepRow[] = [];
    // Refresh and probe one batch at a time, so a signed URL is used right away.
    for(let i = 0; i < discordRows.length; i += REFRESH_BATCH_SIZE) {
        const batch = discordRows.slice(i, i + REFRESH_BATCH_SIZE);
        const fresh = new Map<string, string>();
        try {
            for(const entry of await deps.refreshUrls(batch.map(row => row.url))) {
                if(typeof entry?.original === "string" && typeof entry?.refreshed === "string") fresh.set(entry.original, entry.refreshed);
            }
        } catch(e) {
            deps.log(`Refreshing a batch of ${batch.length} URLs failed: ${e}`);
        }
        await inParallel(batch, PROBE_CONCURRENCY, async (row) => {
            const url = fresh.get(row.url);
            if(!url) return record(row, "refresh_failed");
            const probed = classifyProbe(await deps.probe(url));
            if(probed === "candidate") candidates.push(row);
            else record(row, probed);
        });
    }

    let lookedUp = 0;
    for(const row of candidates) {
        const attachment = parseDiscordAttachmentUrl(row.url);
        if(!attachment) continue;
        if(lookedUp++) await deps.sleep(LOOKUP_INTERVAL_MS);
        record(row, confirmDead(await deps.lookupMessages(attachment.channelId, attachment.attachmentId), attachment.attachmentId));
    }

    if(options.apply) {
        for(const row of summary.dead) summary.archived += await deps.archive(row);
    }
    return summary;
}

export function formatSummary(summary: SweepSummary): string[] {
    const lines = [`${summary.apply ? "APPLY" : "DRY RUN (nothing written; pass --apply to archive)"}: checked ${summary.checked} rows`];
    for(const category of Object.keys(summary.counts).sort()) {
        const counts = summary.counts[category];
        lines.push(`  ${category}: ${Object.keys(counts).sort().map(outcome => `${outcome} ${counts[outcome]}`).join(", ")}`);
    }
    lines.push(`Dead (404 on the CDN and absent from the channel): ${summary.dead.length}`);
    for(const row of summary.dead.slice(0, LISTED_CANDIDATES)) lines.push(`  ${row.category} ${row.id}`);
    if(summary.dead.length > LISTED_CANDIDATES) lines.push(`  ... and ${summary.dead.length - LISTED_CANDIDATES} more`);
    if(summary.apply) lines.push(`Archived as gone_from_discord and removed: ${summary.archived}`);
    return lines;
}

export function parseArgs(argv: string[]): {apply: boolean, limit: number|null}|null {
    const options: {apply: boolean, limit: number|null} = {apply: false, limit: null};
    for(let i = 0; i < argv.length; i++) {
        if(argv[i] === "--apply") options.apply = true;
        else if(argv[i] === "--limit" && /^[1-9][0-9]{0,8}$/.test(argv[i + 1] || "")) options.limit = parseInt(argv[++i], 10);
        else return null;
    }
    return options;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function probe(url: string): Promise<number> {
    for(let attempt = 0; attempt < 5; attempt++) {
        try {
            const response = await fetch(url, {headers: {Range: "bytes=0-0"}, signal: AbortSignal.timeout(15_000)});
            await response.body?.cancel();
            if(response.status !== 429) return response.status;
            const retryAfter = Number(response.headers.get("retry-after"));
            await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000, 60_000));
        } catch(e) {
            return 0;
        }
    }
    return 429;
}

async function main(): Promise<number> {
    require("dotenv").config();
    const options = parseArgs(process.argv.slice(2));
    if(!options) {
        console.error("Usage: node sweepDeadMedia.js [--apply] [--limit N]");
        return 2;
    }
    if(!process.env.CLIENT_TOKEN) {
        console.error("CLIENT_TOKEN is not set.");
        return 2;
    }
    // @discordjs/rest waits out 429s itself, using Retry-After.
    const rest = new REST({version: "10"}).setToken(process.env.CLIENT_TOKEN);
    // Same settings as the bot's pool in util/util.ts, which cannot be imported
    // here: it would open a second pool that nothing closes.
    const pool = mariadb.createPool({
        host: process.env.DB_HOST || "mariadb",
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        idleTimeout: 15,
        connectionLimit: 2
    });
    const {query, transaction} = createDbAccess(pool);
    const tables = [getTableByCommandName("homies"), getTableByCommandName("pets")].filter((table): table is string => !!table);
    try {
        const summary = await sweep({
            async listRows(limit) {
                const rows: SweepRow[] = [];
                for(const table of tables) {
                    if(limit !== null && rows.length >= limit) break;
                    const found: any[] = await query(`SELECT CAST(id AS CHAR) AS id, url FROM ${table} ORDER BY id` + (limit === null ? "" : " LIMIT ?"), limit === null ? [] : [limit - rows.length]);
                    rows.push(...found.map(row => ({category: table, id: String(row.id), url: String(row.url)})));
                }
                return rows;
            },
            async refreshUrls(urls) {
                const response = await rest.post("/attachments/refresh-urls", {body: {attachment_urls: urls}}) as {refreshed_urls?: {original: string, refreshed: string}[]};
                return Array.isArray(response?.refreshed_urls) ? response.refreshed_urls : [];
            },
            probe,
            async lookupMessages(channelId, attachmentId) {
                try {
                    const messages = await rest.get(Routes.channelMessages(channelId), {query: new URLSearchParams({around: attachmentId, limit: String(LOOKUP_LIMIT)})});
                    return Array.isArray(messages) ? {status: 200, messages} : {status: 0, messages: []};
                } catch(e: any) {
                    return {status: Number(e?.status) || 0, messages: []};
                }
            },
            archive: (row) => transaction((inTransaction) => archiveAndDelete(inTransaction, row.category, "gone_from_discord", "t.id = CAST(? AS UNSIGNED) AND t.url = ?", [row.id, row.url])),
            sleep,
            log: (line) => console.info(line)
        }, options);
        for(const line of formatSummary(summary)) console.info(line);
        return 0;
    } finally {
        await pool.end();
    }
}

if(require.main === module) {
    main().then((code) => process.exit(code), (e) => {
        console.error("The sweep failed:", e);
        process.exit(1);
    });
}
