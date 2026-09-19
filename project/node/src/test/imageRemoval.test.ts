import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { archiveAndDelete, mediaKey, parseDiscordAttachmentUrl, QueryFn, removeImageByUrl, removeImagesForMessages, TransactionFn } from "../util/imageRemoval";
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
const REMOVE = (table: string) => `DELETE t FROM ${table} t STRAIGHT_JOIN submissions_archive a ON a.category = ? AND a.id = t.id AND a.reason = ? WHERE`;

describe("archive-then-delete", () => {
    test("copies first, then deletes only what is in the archive, with the same predicate and parameters", async () => {
        const {statements, query} = recorder(() => 2);
        assert.equal(await archiveAndDelete(query, "pets", "message_deleted", "t.guildId = ? AND t.messageId IN (?,?)", ["G", "M1", "M2"]), 2);
        assert.deepEqual(statements, [
            {sql: `${COPY} pets t WHERE t.guildId = ? AND t.messageId IN (?,?)`, params: ["pets", "message_deleted", "G", "M1", "M2"]},
            {sql: `${REMOVE("pets")} t.guildId = ? AND t.messageId IN (?,?)`, params: ["pets", "message_deleted", "G", "M1", "M2"]}
        ]);
    });

    test("a mismatch between copied and deleted rows is an error, so the transaction rolls back", async () => {
        const {query} = recorder(sql => sql.startsWith("INSERT") ? 2 : 1);
        await assert.rejects(archiveAndDelete(query, "homies", "removed_on_site", "t.id = ?", ["1"]), /rolling back/);
    });

    test("a roll is removed by mediaKey from both tables in one transaction", async () => {
        const {log, statements, transaction} = recorder(sql => sql.includes("pets") && sql.startsWith("DELETE") || sql.includes("pets t") && sql.startsWith("INSERT") ? 1 : 0);
        const removed = await removeImageByUrl(transaction, "https://cdn.discordapp.com/attachments/12/34/a.png?ex=1&is=2&hm=3&", "G", "removed_by_reaction");
        assert.equal(removed, 1);
        assert.deepEqual(log, ["begin", "commit"]);
        assert.deepEqual(statements.map(s => s.params), new Array(4).fill(0).map((_, i) => [i < 2 ? "homies" : "pets", "removed_by_reaction", "G", "discord:12/34"]));
        assert.ok(statements.every(s => s.sql.endsWith("WHERE t.guildId = ? AND t.mediaKey = ?")));
        // Elsewhere the query string is part of the identity.
        const other = recorder();
        await removeImageByUrl(other.transaction, "https://example.com/i.php?id=1", "G", "removed_by_reaction");
        assert.equal(other.statements[0].params[3], "https://example.com/i.php?id=1");
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
        const wheres = statements.filter(s => s.sql.startsWith("INSERT")).map(s => [s.sql.split(" FROM ")[1], s.params.slice(2)]);
        assert.deepEqual(wheres, ["homies", "pets"].flatMap(table => [
            [`${table} t WHERE t.guildId = ? AND t.messageId IN (?,?)`, ["G", "M1", "M2"]],
            [`${table} t WHERE t.guildId = ? AND t.messageId IS NULL AND t.mediaKey IN (?,?)`, ["G", "discord:12/34", "discord:12/35"]]
        ]));
        assert.equal(statements.length, 8);
    });

    test("an uncached deleted message needs no attachments, and a database error rolls back and propagates", async () => {
        const plain = recorder();
        await removeImagesForMessages(plain.transaction, "G", ["M"], [], "message_deleted");
        assert.equal(plain.statements.length, 4);
        const failing = recorder();
        const broken: TransactionFn = (work) => failing.transaction(() => work(async () => { throw new Error("down"); }));
        await assert.rejects(removeImagesForMessages(broken, "G", ["M"], [], "message_deleted"), /down/);
        assert.deepEqual(failing.log, ["begin", "rollback"]);
    });

    test("more than 100 deleted messages are split into several IN lists", async () => {
        const {statements, transaction} = recorder();
        await removeImagesForMessages(transaction, "G", new Array(150).fill(0).map((_, i) => `M${i}`), [], "message_deleted");
        assert.deepEqual(statements.filter(s => s.sql.startsWith("INSERT") && s.sql.includes("homies")).map(s => s.params.length - 3), [100, 50]);
    });
});

describe("saving attachments", () => {
    test("one statement for all attachments, where a copy that is already stored changes nothing", () => {
        assert.equal(insertAttachmentsSql("homies", 2), "INSERT INTO homies (url, guildId, userId, channelId, messageId, createdAt) VALUES (?,?,?,?,?,?), (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE userId = userId");
        assert.ok(!/IGNORE/i.test(insertAttachmentsSql("pets", 1)));
    });
});

describe("the archive stays out of sight", () => {
    // Rolls (getPhotoFromTable), /stats and /leaderboard, the API's listing: none
    // of them may ever read submissions_archive. Only the code that writes to it
    // may name it.
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
