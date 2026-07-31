/**
 * MySQL connection pooling and transaction helpers.
 */

import mysql from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { envInt, envStr } from './env';

/**
 * One pool per process, created at startup — never one connection per request.
 *
 * Each MySQL connection is a real server-side thread with its own memory, so
 * opening one per request would both be slow and exhaust max_connections under
 * load. The pool keeps a small set alive and hands them out.
 *
 * `database` is the caller's own schema. The payment service passes
 * 'svc_payment' and is thereby structurally unable to read svc_order's tables.
 */
export function createPool(database: string): Pool {
  return mysql.createPool({
    host: envStr('DB_HOST', '127.0.0.1'),
    port: envInt('DB_PORT', 3306),
    user: envStr('DB_USER', 'saga'),
    password: envStr('DB_PASSWORD', 'saga'),
    database,
    connectionLimit: envInt('DB_POOL_SIZE', 10),
    // Queue callers when every connection is busy rather than throwing.
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    // Interpret DATETIME columns as UTC. The container runs UTC; being explicit
    // means the app behaves the same on a laptop set to IST.
    timezone: 'Z',
    // Send DECIMAL and BIGINT to Node as strings. JS numbers are IEEE-754
    // doubles and cannot represent either exactly — this is how order amounts
    // keep their cents.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
}

/** MySQL error 1062 / ER_DUP_ENTRY — a UNIQUE constraint rejected the insert. */
export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { errno?: number; code?: string };
  return e.errno === 1062 || e.code === 'ER_DUP_ENTRY';
}

/**
 * 1213 = deadlock detected, 1205 = lock wait timeout.
 *
 * Deadlocks are a NORMAL, expected outcome under concurrency, not a bug:
 * transaction A holds row 1 and wants row 2 while B holds row 2 and wants
 * row 1. MySQL detects the cycle and kills one of them. The correct response
 * is to retry the killed transaction, which is what withTransaction does.
 */
export function isDeadlockError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { errno?: number; code?: string };
  return (
    e.errno === 1213 ||
    e.errno === 1205 ||
    e.code === 'ER_LOCK_DEADLOCK' ||
    e.code === 'ER_LOCK_WAIT_TIMEOUT'
  );
}

/**
 * Run `fn` inside a transaction on a single dedicated connection.
 *
 * The dedicated connection is the whole point. If you ran START TRANSACTION on
 * the pool directly, the next statement could borrow a DIFFERENT connection
 * and silently execute outside your transaction — a bug that looks fine in dev
 * (pool of 10, low traffic, you usually get the same connection back) and
 * corrupts data under load.
 *
 * `finally { conn.release() }` is not optional: a leaked connection is gone
 * from the pool forever, and ten leaks hang the process.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (conn: PoolConnection) => Promise<T>,
  options: { maxDeadlockRetries?: number } = {},
): Promise<T> {
  const maxDeadlockRetries = options.maxDeadlockRetries ?? 3;

  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      // Rollback can itself fail if the connection died; the original error is
      // the interesting one, so swallow this and rethrow that.
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      if (isDeadlockError(err) && attempt < maxDeadlockRetries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

export type { Pool, PoolConnection };
