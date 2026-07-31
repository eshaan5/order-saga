/**
 * Service-side idempotency. This is requirement 5 — "never do a step twice,
 * even after a retry or a slow/lost reply" — and it is the single most
 * important piece of logic in the system.
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * The coordinator calls CHARGE_PAYMENT with a 3s timeout. The payment service
 * charges the card successfully at 3.1s. The coordinator has already given up
 * and retries. Without protection the customer is charged twice, and no amount
 * of care on the coordinator side can prevent it — it cannot distinguish "the
 * call never arrived" from "the call arrived and the reply was lost".
 *
 * So the guarantee has to live in the service, keyed on something stable.
 *
 * THE FLOW
 * --------
 *   1. INSERT the key as IN_PROGRESS.
 *        duplicate key? -> read the existing row:
 *          COMPLETED           -> return its stored response. Done, no work.
 *          IN_PROGRESS (fresh) -> a twin is mid-flight; throw 409 so the
 *                                 coordinator retries in a moment.
 *          IN_PROGRESS (stale) -> its owner died; take it over.
 *   2. Do the real work AND flip the row to COMPLETED in ONE transaction, so
 *      it is impossible to have done the work without recording it.
 *   3. If the work throws, delete the claim so a later retry isn't blocked by
 *      our own abandoned marker.
 *
 * WHY THE IN_PROGRESS STATE EXISTS
 * --------------------------------
 * If we only stored completed operations, two simultaneous requests with the
 * same key would both find nothing, both pass the check, and both execute.
 * The IN_PROGRESS row closes that window: the UNIQUE constraint means exactly
 * one of them wins the INSERT.
 */

import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { idempotencyCacheKey, type Cache } from './cache';
import { isDuplicateKeyError } from './db';
import { OperationInProgressError } from './errors';

export interface IdempotencyContext {
  /** Deterministic: `${orderId}:${step}`. Never random. */
  key: string;
  operation: string;
  orderId: string;
}

export interface IdempotentResult<T> {
  result: T;
  /** True when the stored response was replayed instead of re-executing. */
  replayed: boolean;
}

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_CACHE_TTL_SECONDS = 3600;

export async function runIdempotent<T>(
  pool: Pool,
  ctx: IdempotencyContext,
  work: (conn: PoolConnection) => Promise<T>,
  options: { staleMs?: number; cache?: Cache; cacheTtlSeconds?: number } = {},
): Promise<IdempotentResult<T>> {
  const staleSeconds = Math.max(1, Math.ceil((options.staleMs ?? DEFAULT_STALE_MS) / 1000));
  const cacheTtl = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  const cache = options.cache;
  const cacheKey = idempotencyCacheKey(ctx.key);

  // ---- Fast path: has this exact operation already completed? --------------
  // Requirement: "a fast lookup for whether a step has already been done for
  // an order, so the 'never do a step twice' check stays fast under load."
  //
  // A hit returns without touching MySQL at all — no connection borrowed, no
  // query. A miss (or Redis being down) simply falls through to the database.
  //
  // This is safe to read before any locking because we only ever CACHE
  // completed records, and a completed record is immutable — nothing in the
  // system updates or deletes one. The cache therefore cannot serve a stale
  // answer, because there is no newer answer to serve.
  if (cache) {
    const hit = await cache.get<T>(cacheKey);
    if (hit !== null) return { result: hit, replayed: true };
  }

  const conn = await pool.getConnection();

  try {
    // ---- Phase 1: claim the key --------------------------------------------
    try {
      await conn.execute<ResultSetHeader>(
        `INSERT INTO idempotency_records (idempotency_key, operation, order_id, status)
         VALUES (?, ?, ?, 'IN_PROGRESS')`,
        [ctx.key, ctx.operation, ctx.orderId],
      );
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;

      const [rows] = await conn.execute<RowDataPacket[]>(
        `SELECT status, response_json FROM idempotency_records WHERE idempotency_key = ?`,
        [ctx.key],
      );
      const row = rows[0];

      // Already done — replay the stored response. The customer is not
      // charged again; the coordinator gets the same answer as the first time.
      if (row && row['status'] === 'COMPLETED') {
        const result = row['response_json'] as T;
        // Warm the cache so the next retry of this step skips MySQL entirely.
        await cache?.set(cacheKey, result, cacheTtl);
        return { result, replayed: true };
      }

      // Still IN_PROGRESS. Decide fresh-vs-stale in SQL rather than in JS, so
      // the check and the takeover are one atomic statement and no two
      // instances can both conclude "it's stale, I'll take it".
      const [takeover] = await conn.execute<ResultSetHeader>(
        `UPDATE idempotency_records
            SET created_at = NOW(3)
          WHERE idempotency_key = ?
            AND status = 'IN_PROGRESS'
            AND created_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)`,
        [ctx.key, staleSeconds],
      );

      // affectedRows 0 means either the claim is still fresh, or another
      // instance won the takeover race. Either way it isn't ours — tell the
      // coordinator to come back shortly (409 is classified as retryable).
      if (takeover.affectedRows === 0) {
        throw new OperationInProgressError(ctx.key);
      }
    }

    // ---- Phase 2: do the work and record completion atomically -------------
    try {
      await conn.beginTransaction();

      const result = await work(conn);

      await conn.execute<ResultSetHeader>(
        `UPDATE idempotency_records
            SET status = 'COMPLETED', response_json = ?, completed_at = NOW(3)
          WHERE idempotency_key = ?`,
        [JSON.stringify(result ?? null), ctx.key],
      );

      // The work and the "we did the work" record commit together or not at
      // all. There is no window where the money moved but we forgot.
      await conn.commit();

      // Populate the cache ONLY AFTER the commit succeeds. Writing it earlier
      // would let Redis assert something MySQL might still roll back — the
      // cache would then be claiming an operation happened when it hadn't,
      // which is precisely the double-charge this whole file exists to prevent.
      await cache?.set(cacheKey, result, cacheTtl);

      return { result, replayed: false };
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* the original error is the interesting one */
      }

      // Release our claim. Without this, a step that fails once would leave an
      // IN_PROGRESS marker that blocks its own retries until it went stale —
      // turning a transient blip into a guaranteed cancellation.
      try {
        await conn.execute(
          `DELETE FROM idempotency_records
            WHERE idempotency_key = ? AND status = 'IN_PROGRESS'`,
          [ctx.key],
        );
      } catch {
        /* best effort; the staleness path will reclaim it otherwise */
      }

      throw err;
    }
  } finally {
    conn.release();
  }
}
