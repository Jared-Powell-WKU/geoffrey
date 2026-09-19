// The INSERT behind saveAttachments, apart from util.ts so tests can run the
// very statement against a real database.
//
// A second copy of an attachment (same guild and mediaKey, or the same URL)
// must be skipped without failing the other rows of a multi-row INSERT. That is
// ON DUPLICATE KEY UPDATE with an assignment that changes nothing, rather than
// INSERT IGNORE, which would also swallow truncation and every other error.
export function insertAttachmentsSql(table: string, rows: number): string {
    const values = new Array(rows).fill("(?,?,?,?,?,?)").join(", ");
    return `INSERT INTO ${table} (url, guildId, userId, channelId, messageId, createdAt) VALUES ${values} ON DUPLICATE KEY UPDATE userId = userId`;
}
