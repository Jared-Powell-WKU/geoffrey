import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErasedReason, isArchivedReason, mediaKey, parseDiscordAttachmentUrl, QueryFn, removalSql, removeImageByUrl, removeImagesForMessages, removeRows, TransactionFn } from "../util/imageRemoval";
import { insertAttachmentsSql } from "../util/submissionSql";
import { MEDIA_KEY_CASES, OWN_KEY_CASES } from "./helpers";

describe("mediaKey", () => {
    test("a Discord attachment is keyed by channel and attachment id, whatever its signature, host or file name", () => {
        for(const [url, key] of MEDIA_KEY_CASES) assert.equal(mediaKey(url), key, url);
        assert.deepEqual(parseDiscordAttachmentUrl(MEDIA_KEY_CASES[4][0]), {channelId: "700000000000000001", attachmentId: "1100000000000000000"});
    });

    test("anything else is its own key, query string included", () => {
        for(const url of OWN_KEY_CASES) {
            assert.equal(mediaKey(url), url);
            assert.equal(parseDiscordAttachmentUrl(url), null, url);
        }
    });
});

function recorder(affectedRows: (sql: string) => number = () => 0) {
    const log: string[] = [];
    const statements: {sql: string, params: unknown[]}[] = [];
    const query: QueryFn = async (sql, params = []) => {
        statements.push({sql, params});
        return {affectedRows: affectedRows(sql)};
    };
    const transaction: TransactionFn = async (work) => {
        log.push("begin");
        try {
            const result = await work(query);
            log.push("commit");
            return result;
        } catch(e) {
            log.push("rollback");
            throw e;
        }
    };
    return {log, statements, query, transaction};
}

const COPY = "INSERT INTO submissions_archive (category, id, url, guildId, userId, createdAt, source, channelId, messageId, reason) SELECT ?, t.id, t.url, t.guildId, t.userId, t.createdAt, t.source, t.channelId, t.messageId, ? FROM";
const REMOVE_ARCHIVED = (table: string) => `DELETE t FROM ${table} t STRAIGHT_JOIN submissions_archive a ON a.category = ? AND a.id = t.id AND a.reason = ? WHERE`;
const ERASED: ErasedReason[] = ["message_deleted", "removed_by_reaction", "removed_on_site"];

describe("the removal policy", () => {
    test("only the bot's own judgment is archived; what a person asked for is not", () => {
        assert.equal(isArchivedReason("gone_from_discord"), true);
        for(const reason of ERASED) assert.equal(isArchivedReason(reason), false, reason);
    });

    test("a removal a person asked for is one plain delete that never names the archive", async () => {
        for(const reason of ERASED) {
            const {statements, query} = recorder(() => 2);
            assert.equal(await removeRows(query, "pets", reason, "t.guildId = ? AND t.messageId IN (?,?)", ["G", "M1", "M2"]), 2);
            assert.deepEqual(statements, [{sql: "DELETE t FROM pets t WHERE t.guildId = ? AND t.messageId IN (?,?)", params: ["G", "M1", "M2"]}], reason);
            assert.deepEqual(removalSql("pets", reason, "t.id = ?"), {copy: null, remove: "DELETE t FROM pets t WHERE t.id = ?"});
        }
    });

    test("the bot's own judgment copies first, then deletes only what is in the archive, with the same predicate and parameters", async () => {
        const {statements, query} = recorder(() => 1);
        assert.equal(await removeRows(query, "pets", "gone_from_discord", "t.id = CAST(? AS UNSIGNED) AND t.url = ?", ["7", "https://x.y/z"]), 1);
        assert.deepEqual(statements, [
            {sql: `${COPY} pets t WHERE t.id = CAST(? AS UNSIGNED) AND t.url = ?`, params: ["pets", "gone_from_discord", "7", "https://x.y/z"]},
            {sql: `${REMOVE_ARCHIVED("pets")} t.id = CAST(? AS UNSIGNED) AND t.url = ?`, params: ["pets", "gone_from_discord", "7", "https://x.y/z"]}
        ]);
    });

    test("a mismatch between copied and deleted rows is an error, so the transaction rolls back", async () => {
        const {query} = recorder(sql => sql.startsWith("INSERT") ? 2 : 1);
        await assert.rejects(removeRows(query, "homies", "gone_from_discord", "t.id = ?", ["1"]), /rolling back/);
    });
});

describe("removals people ask for", () => {
    test("a roll is removed by mediaKey from both tables in one transaction", async () => {
        const {log, statements, transaction} = recorder(sql => sql.includes("pets") ? 1 : 0);
        const removed = await removeImageByUrl(transaction, "https://cdn.discordapp.com/attachments/12/34/a.png?ex=1&is=2&hm=3&", "G", "removed_by_reaction");
        assert.equal(removed, 1);
        assert.deepEqual(log, ["begin", "commit"]);
        assert.deepEqual(statements, ["homies", "pets"].map(table => ({sql: `DELETE t FROM ${table} t WHERE t.guildId = ? AND t.mediaKey = ?`, params: ["G", "discord:12/34"]})));
        // Elsewhere the query string is part of the identity.
        const other = recorder();
        await removeImageByUrl(other.transaction, "https://example.com/i.php?id=1", "G", "removed_by_reaction");
        assert.equal(other.statements[0].params[1], "https://example.com/i.php?id=1");
    });

    test("messages are removed by id, then legacy rows by the attachments' mediaKeys", async () => {
        const {log, statements, transaction} = recorder();
        const removed = await removeImagesForMessages(transaction, "G", ["M1", "M2"], [
            "https://cdn.discordapp.com/attachments/12/34/a.png?ex=1&is=2&hm=3&",
            "https://media.discordapp.net/attachments/12/34/a.png?ex=1&is=2&hm=3&",
            "https://cdn.discordapp.com/attachments/12/35/b.png",
            ""
        ], "message_deleted");
        assert.equal(removed, 0);
        assert.deepEqual(log, ["begin", "commit"]);
        assert.deepEqual(statements, ["homies", "pets"].flatMap(table => [
            {sql: `DELETE t FROM ${table} t WHERE t.guildId = ? AND t.messageId IN (?,?)`, params: ["G", "M1", "M2"]},
            {sql: `DELETE t FROM ${table} t WHERE t.guildId = ? AND t.messageId IS NULL AND t.mediaKey IN (?,?)`, params: ["G", "discord:12/34", "discord:12/35"]}
        ]));
    });

    test("an uncached deleted message needs no attachments, and a database error rolls back and propagates", async () => {
        const plain = recorder();
        await removeImagesForMessages(plain.transaction, "G", ["M"], [], "message_deleted");
        assert.equal(plain.statements.length, 2);
        const failing = recorder();
        const broken: TransactionFn = (work) => failing.transaction(() => work(async () => { throw new Error("down"); }));
        await assert.rejects(removeImagesForMessages(broken, "G", ["M"], [], "message_deleted"), /down/);
        assert.deepEqual(failing.log, ["begin", "rollback"]);
    });

    test("more than 100 deleted messages are split into several IN lists", async () => {
        const {statements, transaction} = recorder();
        await removeImagesForMessages(transaction, "G", new Array(150).fill(0).map((_, i) => `M${i}`), [], "message_deleted");
        assert.deepEqual(statements.filter(s => s.sql.includes("homies")).map(s => s.params.length - 1), [100, 50]);
    });

    test("none of them ever names the archive", async () => {
        const {statements, transaction} = recorder();
        await removeImageByUrl(transaction, "https://cdn.discordapp.com/attachments/12/34/a.png", "G", "removed_by_reaction");
        await removeImagesForMessages(transaction, "G", ["M"], ["https://cdn.discordapp.com/attachments/12/34/a.png"], "message_deleted");
        assert.ok(statements.length > 0 && !statements.some(s => /submissions_archive|INSERT/i.test(s.sql)));
    });
});

describe("saving attachments", () => {
    test("one statement for all attachments, where a copy that is already stored changes nothing", () => {
        assert.equal(insertAttachmentsSql("homies", 2), "INSERT INTO homies (url, guildId, userId, channelId, messageId, createdAt) VALUES (?,?,?,?,?,?), (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE userId = userId");
        assert.ok(!/IGNORE/i.test(insertAttachmentsSql("pets", 1)));
    });
});

describe("the archive stays out of sight", () => {
    // Rolls (getPhotoFromTable), /stats and /leaderboard, the API's listing and
    // its DELETE: none of them may ever touch submissions_archive. Only the one
    // module that holds the removal policy may name it.
    test("no compiled file but the removal code mentions submissions_archive", () => {
        const dist = path.join(__dirname, "..");
        const mentions: string[] = [];
        const walk = (dir: string) => {
            for(const entry of fs.readdirSync(dir, {withFileTypes: true})) {
                const full = path.join(dir, entry.name);
                if(entry.isDirectory()) {
                    if(entry.name !== "test" && entry.name !== "node_modules") walk(full);
                } else if(entry.name.endsWith(".js") && /submissions_archive/i.test(fs.readFileSync(full, "utf8"))) {
                    mentions.push(path.relative(dist, full).replace(/\\/g, "/"));
                }
            }
        };
        walk(dist);
        assert.deepEqual(mentions.sort(), ["util/imageRemoval.js"]);
        for(const file of ["util/util.js", "commands/geoffreystats.js", "commands/io.js"]) assert.ok(fs.existsSync(path.join(dist, file)), file);
    });
});
