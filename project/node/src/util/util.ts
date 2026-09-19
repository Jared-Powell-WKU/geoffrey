import * as mariadb from "mariadb";
import * as dotenv from "dotenv";
import { Attachment, Client, Collection, User } from "discord.js";
import { getTableByCommandName } from "./tables";
import { ErasedReason, removeImageByUrl, removeImagesForMessages } from "./imageRemoval";
import { insertAttachmentsSql } from "./submissionSql";
import { createDbAccess } from "./dbAccess";
dotenv.config();

export { getTableByCommandName };

export interface SupportedGuild {
    guildId: string,
    adminRoleName: string;
    channels: {
        homies: string[],
        pets: string[]
    }
}

export interface GuildDictionary {
    [key: string]: SupportedGuild
}

const pool = mariadb.createPool({
    host:process.env.DB_HOST || "mariadb",
    user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,
    database:process.env.DB_NAME,
    idleTimeout:15,
    connectionLimit:5
});

export async function getSupportedGuildByGuildId(guildId: string) {
    const guilds: GuildDictionary = JSON.parse(process.env.GUILDS || '{}');
    return Object.values(guilds).filter((e: SupportedGuild)=>{return e?.guildId == guildId})[0] || {};
}

export async function getDatabase(): Promise<mariadb.PoolConnection> {
    let conn: mariadb.PoolConnection;
    try {
        return await pool.getConnection();
    } catch(e) {
        console.error("Unable to establish connection with database:", e);
        throw e;
    }
}

export async function setInputOutputValue(guildId: string, ioKey:string, ioValue:string, memberId:string|undefined): Promise<boolean> {
    const db = await getDatabase();
    let updateSuccessful = true;
    try {
            const dbres = await db.query("SELECT 1 AS `value` FROM inputoutput WHERE `name` = ? AND guildId = ?", [ioKey, guildId]);
            if(dbres[0]?.value) await db.query("UPDATE inputoutput SET `value` = ? WHERE `name` = ? AND guildId = ?", [ioValue, ioKey, guildId]);
            else await db.query("INSERT INTO inputoutput (`name`, `value`, `guildId`, `userId`) VALUES (?, ?, ?, ?)", [ioKey, ioValue, guildId, memberId]);
    } catch(e) {
        console.error(`Error setting IO value for ${ioKey}: ${ioValue}`, e);
        updateSuccessful = false;
    } finally {
        db.end();
        return updateSuccessful;
    }
}

export async function getInputOutputValue(guildId: string, ioKey:string): Promise<string|undefined> {
    const db = await getDatabase();
    let bracket;
    try {
        bracket = await db.query("SELECT `value` FROM inputoutput WHERE `name` = ? AND guildId = ?", [ioKey, guildId]);
    } catch(e) {
        console.error(`Error getting value ${ioKey} from inputoutput`, e);
    } finally {
        db.end();
        return bracket[0]?.value;
    }
}

export async function getPhotoFromTable(guildId:any, userId:string|null, table:string|undefined): Promise<string|undefined> {
    if(!table) {
        throw 'No table specified'
    }
    const db = await getDatabase();
    let r;
    try {
        r = await db.query(`SELECT \`url\` FROM ${table} WHERE guildId = ? ${userId ? 'AND userId = ?' : ""} ORDER BY RAND() LIMIT 1`, (userId ? [guildId, userId] : [guildId]));
    } catch(e) {
        console.error(`Error getting photo from table ${table}:`, e)
    } finally {
        db.end();
        return r[0]?.url;
    }

}

export interface AttachmentOrigin {
    channelId: string,
    messageId: string,
    createdAt: Date
}

// DATETIME columns hold UTC. Passing a string keeps the driver from applying
// the process time zone to a Date.
export function toUtcDateTime(date: Date): string {
    return date.toISOString().slice(0, 19).replace("T", " ");
}

export async function saveAttachments(attachments: Collection<string, Attachment>, guildId: any, table: string|undefined, member:string|null = null, origin: AttachmentOrigin|null = null) : Promise<boolean> {
    if(!attachments.size) return false;
    if(!table) {
        throw 'No table provided';
    }
    const db: mariadb.PoolConnection = await getDatabase();
    let res = null;
    try {
        if(member) {
            const isUser = await db.query(`SELECT 1 AS val FROM users WHERE id = ? AND guildId = ?`, [member, guildId]);
            if(!isUser[0]?.val) await addUserToDatabase(db, member, guildId);
        }
        let params: (string|null)[] = [];
        const createdAt = origin ? toUtcDateTime(origin.createdAt) : null;
        attachments.forEach((v: any)=>{
            params.push(v.attachment, guildId, member, origin?.channelId ?? null, origin?.messageId ?? null, createdAt)
        })
        // An attachment that is already stored is skipped, and that still counts
        // as saved: the caller's camera reaction means "this is stored".
        res = await db.query(insertAttachmentsSql(table, attachments.size), params);
    } catch(e) {
        console.error(e);
    } finally {
        db.end();
        return !(res === null);
    }
}

export async function deleteImage(url:string, guildId:string, reason: ErasedReason): Promise<boolean> {
    try {
        return await removeImageByUrl(transaction, url, guildId, reason) > 0;
    } catch(e) {
        console.error(`There was a problem deleting URL ${url} from the database.`, e);
        return false;
    }
}

// Rejects when the database could not be asked, so the caller can tell
// "nothing is stored for these messages" (0) from "unknown".
export async function deleteImagesForMessages(guildId: string, messageIds: string[], attachmentUrls: string[], reason: ErasedReason): Promise<number> {
    return await removeImagesForMessages(transaction, guildId, messageIds, attachmentUrls, reason);
}

export async function fetchUser(userId: string, client:Client): Promise<User> {
    const user: User = await client.users.fetch(userId);
    return user;
}

export async function executeQuery(query: string, params: [any]): Promise<[Record<string, any>]> {
    const db = await getDatabase();
    let res;
    try {
        res = await db.query(query, params);
    } catch(e) {
        console.error("There was a problem executing query.", query, params);
        throw e;
    } finally {
        db.end()
        return res;
    }
}

export const {query, transaction} = createDbAccess(pool);

async function addUserToDatabase(db: mariadb.PoolConnection, member: string, guildId: string) {
    let res;
    try {
        res = await db.query("INSERT INTO users (id, guildId) VALUES (?,?)", [member, guildId]);
    } catch(e) {
        console.error("There was a problem adding user "+member+" to database.", e);
        throw e;
    }
    return res;
}