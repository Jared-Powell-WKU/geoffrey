// Query helpers over a mariadb pool. Kept apart from util.ts, which creates the
// bot's pool on import, so tests and the maintenance tools can bring their own.
import type { Pool } from "mariadb";
import type { QueryFn, TransactionFn } from "./imageRemoval";

export function createDbAccess(pool: Pool): {query: QueryFn, transaction: TransactionFn} {
    // Unlike executeQuery in util.ts, errors propagate to the caller and the
    // connection is always returned to the pool.
    const query: QueryFn = async (sql, params = []) => {
        const db = await pool.getConnection();
        try {
            return await db.query(sql, params);
        } finally {
            await db.release();
        }
    };
    const transaction: TransactionFn = async (work) => {
        const db = await pool.getConnection();
        try {
            await db.beginTransaction();
            const result = await work((sql, params = []) => db.query(sql, params));
            await db.commit();
            return result;
        } catch(e) {
            // A failed rollback must not hide the error that caused it.
            await db.rollback().catch(() => {});
            throw e;
        } finally {
            await db.release();
        }
    };
    return {query, transaction};
}
