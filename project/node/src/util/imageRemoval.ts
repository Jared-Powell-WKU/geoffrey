// Removal of stored images: one code path, removeRows, for every way a row
// leaves homies or pets. Free of side effects (database access is passed in)
// so it can be tested against a real database without the bot's pool.
import { getTableByCommandName } from "./tables";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<any>;
// Runs the work on one connection inside one transaction: commit when it
// resolves, roll back when it rejects.
export type TransactionFn = <T>(work: (query: QueryFn) => Promise<T>) => Promise<T>;

// THE POLICY, and the only place it lives.
// A removal a person asked for is a real delete with no copy kept: taking an
// image down on the site, the author's or a mod's cross, the five-vote purge,
// a mod's bomb, deleting the Discord message. They meant it.
// A removal that is the bot's own judgment is archived first, in the same
// transaction, because the bot can be wrong and the row must be reviewable and
// restorable: the sweep deciding an attachment is gone from Discord, and
// migration 003 deciding a row is a duplicate ('duplicate' is written only there).
export type ErasedReason = "message_deleted" | "removed_by_reaction" | "removed_on_site";
export type ArchivedReason = "gone_from_discord";
export type RemovalReason = ErasedReason | ArchivedReason;

const ARCHIVED_REASONS: readonly string[] = ["gone_from_discord"] satisfies ArchivedReason[];

export function isArchivedReason(reason: RemovalReason): reason is ArchivedReason {
    return ARCHIVED_REASONS.includes(reason);
}

const DISCORD_ATTACHMENT = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/([0-9]+)\/([0-9]+)\//;
// MessageBulkDelete carries at most 100 messages; this also bounds the IN lists.
const CHUNK = 100;

function submissionTables(): string[] {
    return [getTableByCommandName("homies"), getTableByCommandName("pets")].filter((table): table is string => !!table);
}

export function parseDiscordAttachmentUrl(url: string): {channelId: string, attachmentId: string}|null {
    const match = DISCORD_ATTACHMENT.exec(url);
    return match ? {channelId: match[1], attachmentId: match[2]} : null;
}

// What a row is a picture OF; the twin of the generated mediaKey column in
// migrations/003_dedupe_media.sql, and the two must agree (the integration
// test compares them). A Discord attachment is the same picture whatever its
// signature, host or file name says: Discord re-signs ?ex=&is=&hm= every time
// a message is fetched, so the URL on a message today rarely equals the one
// stored when it was posted. Any other URL is its own key, query string
// included and case-sensitive, because elsewhere the query can select the image.
export function mediaKey(url: string): string {
    const attachment = parseDiscordAttachmentUrl(url);
    return attachment ? `discord:${attachment.channelId}/${attachment.attachmentId}` : url;
}

const ARCHIVE_COLUMNS = ["id", "url", "guildId", "userId", "createdAt", "source", "channelId", "messageId"];

// The statements that remove the rows matching `where` (written against the alias t).
// Erased: one plain delete, taking the params of where.
// Archived: a copy into submissions_archive, then a delete that can only hit rows
// that are in the archive; both take [table, reason, ...params of where].
// STRAIGHT_JOIN makes that delete start from the few rows `where` selects
// instead of walking the archive.
export function removalSql(table: string, reason: RemovalReason, where: string): {copy: string|null, remove: string} {
    if(!isArchivedReason(reason)) return {copy: null, remove: `DELETE t FROM ${table} t WHERE ${where}`};
    return {
        copy: `INSERT INTO submissions_archive (category, ${ARCHIVE_COLUMNS.join(", ")}, reason) SELECT ?, ${ARCHIVE_COLUMNS.map(column => `t.${column}`).join(", ")}, ? FROM ${table} t WHERE ${where}`,
        remove: `DELETE t FROM ${table} t STRAIGHT_JOIN submissions_archive a ON a.category = ? AND a.id = t.id AND a.reason = ? WHERE ${where}`
    };
}

// Removes the rows matching `where` the way the policy above says for that
// reason: deleted outright, or copied to the archive and then deleted. Must be
// given the query function of an open transaction. Returns the row count.
export async function removeRows(query: QueryFn, table: string, reason: RemovalReason, where: string, params: unknown[]): Promise<number> {
    const sql = removalSql(table, reason, where);
    if(sql.copy === null) {
        const deleted = await query(sql.remove, params);
        return Number(deleted?.affectedRows ?? 0);
    }
    const archived = await query(sql.copy, [table, reason, ...params]);
    const deleted = await query(sql.remove, [table, reason, ...params]);
    const count = Number(deleted?.affectedRows ?? 0);
    if(Number(archived?.affectedRows ?? 0) !== count) {
        throw new Error(`Archived ${archived?.affectedRows} rows of ${table} but deleted ${count}; rolling back.`);
    }
    return count;
}

function placeholders(values: unknown[]): string {
    return values.map(() => "?").join(",");
}

// Removes the image a bot-authored message (a roll or a web-add notice) shows.
export async function removeImageByUrl(transaction: TransactionFn, url: string, guildId: string, reason: ErasedReason): Promise<number> {
    return await transaction(async (query) => {
        let removed = 0;
        for(const table of submissionTables()) {
            removed += await removeRows(query, table, reason, "t.guildId = ? AND t.mediaKey = ?", [guildId, mediaKey(url)]);
        }
        return removed;
    });
}

// Removes everything stored for submission messages of one guild: rows that
// recorded the message id, then rows from before messageId existed, matched by
// the attachments the messages are known to carry. Pass every URL form of each
// attachment (url and proxyURL). Resolving with 0 means nothing is stored for
// those messages; a database error rejects.
export async function removeImagesForMessages(transaction: TransactionFn, guildId: string, messageIds: string[], attachmentUrls: string[], reason: ErasedReason): Promise<number> {
    const keys = [...new Set(attachmentUrls.filter(url => !!url).map(mediaKey))];
    return await transaction(async (query) => {
        let removed = 0;
        for(const table of submissionTables()) {
            for(let i = 0; i < messageIds.length; i += CHUNK) {
                const chunk = messageIds.slice(i, i + CHUNK);
                removed += await removeRows(query, table, reason, `t.guildId = ? AND t.messageId IN (${placeholders(chunk)})`, [guildId, ...chunk]);
            }
            for(let i = 0; i < keys.length; i += CHUNK) {
                const chunk = keys.slice(i, i + CHUNK);
                removed += await removeRows(query, table, reason, `t.guildId = ? AND t.messageId IS NULL AND t.mediaKey IN (${placeholders(chunk)})`, [guildId, ...chunk]);
            }
        }
        return removed;
    });
}
