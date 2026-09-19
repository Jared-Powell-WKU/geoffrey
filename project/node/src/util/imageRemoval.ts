// Removal of stored images. Nothing is hard-deleted: a row leaves homies or
// pets only in the same transaction that copies it into submissions_archive.
// Free of side effects (database access is passed in) so it can be tested
// against a real database without the bot's pool.
import { getTableByCommandName } from "./tables";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<any>;
// Runs the work on one connection inside one transaction: commit when it
// resolves, roll back when it rejects.
export type TransactionFn = <T>(work: (query: QueryFn) => Promise<T>) => Promise<T>;

// The values of submissions_archive.reason the bot writes ('duplicate' belongs to migration 003).
export type RemovalReason = "gone_from_discord" | "message_deleted" | "removed_by_reaction" | "removed_on_site";

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

// The two statements of an archive-then-delete; both take [table, reason, ...params of where].
// The delete can only hit rows that are in the archive. STRAIGHT_JOIN makes it
// start from the few rows `where` selects instead of walking the archive.
export function archiveAndDeleteSql(table: string, where: string): {copy: string, remove: string} {
    return {
        copy: `INSERT INTO submissions_archive (category, ${ARCHIVE_COLUMNS.join(", ")}, reason) SELECT ?, ${ARCHIVE_COLUMNS.map(column => `t.${column}`).join(", ")}, ? FROM ${table} t WHERE ${where}`,
        remove: `DELETE t FROM ${table} t STRAIGHT_JOIN submissions_archive a ON a.category = ? AND a.id = t.id AND a.reason = ? WHERE ${where}`
    };
}

// Copies the rows matching `where` (written against the alias t) into
// submissions_archive and then deletes exactly the rows that were copied. Must
// be given the query function of an open transaction. Returns the row count.
export async function archiveAndDelete(query: QueryFn, table: string, reason: RemovalReason, where: string, params: unknown[]): Promise<number> {
    const sql = archiveAndDeleteSql(table, where);
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
export async function removeImageByUrl(transaction: TransactionFn, url: string, guildId: string, reason: RemovalReason): Promise<number> {
    return await transaction(async (query) => {
        let removed = 0;
        for(const table of submissionTables()) {
            removed += await archiveAndDelete(query, table, reason, "t.guildId = ? AND t.mediaKey = ?", [guildId, mediaKey(url)]);
        }
        return removed;
    });
}

// Removes everything stored for submission messages of one guild: rows that
// recorded the message id, then rows from before messageId existed, matched by
// the attachments the messages are known to carry. Pass every URL form of each
// attachment (url and proxyURL). Resolving with 0 means nothing is stored for
// those messages; a database error rejects.
export async function removeImagesForMessages(transaction: TransactionFn, guildId: string, messageIds: string[], attachmentUrls: string[], reason: RemovalReason): Promise<number> {
    const keys = [...new Set(attachmentUrls.filter(url => !!url).map(mediaKey))];
    return await transaction(async (query) => {
        let removed = 0;
        for(const table of submissionTables()) {
            for(let i = 0; i < messageIds.length; i += CHUNK) {
                const chunk = messageIds.slice(i, i + CHUNK);
                removed += await archiveAndDelete(query, table, reason, `t.guildId = ? AND t.messageId IN (${placeholders(chunk)})`, [guildId, ...chunk]);
            }
            for(let i = 0; i < keys.length; i += CHUNK) {
                const chunk = keys.slice(i, i + CHUNK);
                removed += await archiveAndDelete(query, table, reason, `t.guildId = ? AND t.messageId IS NULL AND t.mediaKey IN (${placeholders(chunk)})`, [guildId, ...chunk]);
            }
        }
        return removed;
    });
}
