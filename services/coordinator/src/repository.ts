/**
 * Every SQL statement the coordinator runs against the `saga` schema.
 *
 * Kept in one file deliberately: the claim query and the lease guards are the
 * correctness-critical part of this system, and they are much easier to review
 * sitting next to each other than scattered through the engine.
 */

import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  idempotencyKey,
  stepKind,
  withTransaction,
  type AttemptInfo,
  type ForwardStep,
  type OrderStatus,
  type Step,
  type StepStatus,
} from '@saga/shared';

export interface ClaimedOrder {
  id: number;
  orderId: string;
  sku: string;
  qty: number;
  /** String all the way through — see the DECIMAL note in the MySQL doc. */
  amount: string;
  failAt: string | null;
  compFailAt: string | null;
  status: OrderStatus;
}

function toClaimedOrder(row: RowDataPacket): ClaimedOrder {
  return {
    id: Number(row['id']),
    orderId: String(row['order_id']),
    sku: String(row['sku']),
    qty: Number(row['qty']),
    amount: String(row['amount']),
    failAt: (row['fail_at'] as string | null) ?? null,
    compFailAt: (row['comp_fail_at'] as string | null) ?? null,
    status: row['status'] as OrderStatus,
  };
}

/**
 * THE CLAIM QUERY. Multi-instance safety and crash recovery, in one statement.
 *
 * `FOR UPDATE`     takes an exclusive row lock, held until COMMIT.
 * `SKIP LOCKED`    passes over rows another transaction already locked instead
 *                  of queueing behind them.
 *
 * Ten coordinators running this simultaneously each get a DIFFERENT set of
 * rows. Without SKIP LOCKED they would either all get the same rows (no lock)
 * or serialise into a single-file queue (lock, no skip).
 *
 * The second WHERE clause is requirement 6 in its entirety:
 *
 *     OR (status IN ('IN_PROGRESS','COMPENSATING') AND lease_expires_at < NOW(3))
 *
 * A crashed coordinator stops renewing its lease. The lease goes stale. The
 * next poll by any instance picks the order back up. There is no separate
 * recovery daemon, and a restarted process needs no special startup logic —
 * it just starts polling and abandoned work flows back in.
 *
 * COMPENSATING is included so an order that crashed mid-rollback resumes
 * rolling back rather than being re-run forwards.
 *
 * Note the transaction is deliberately TINY: select, stamp, commit. No HTTP
 * calls inside it. The row locks release at COMMIT; the much longer saga is
 * protected by the lease instead, which is data rather than a lock.
 */
export async function claimBatch(
  pool: Pool,
  instanceId: string,
  batchSize: number,
  leaseTtlMs: number,
): Promise<ClaimedOrder[]> {
  return withTransaction(pool, async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, order_id, sku, qty, amount, fail_at, comp_fail_at, status
         FROM saga_orders
        WHERE status = 'PENDING'
           OR (status IN ('IN_PROGRESS','COMPENSATING') AND lease_expires_at < NOW(3))
        ORDER BY id
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    if (rows.length === 0) return [];

    const ids = rows.map((r) => Number(r['id']));

    await conn.query<ResultSetHeader>(
      `UPDATE saga_orders
          SET status = IF(status = 'COMPENSATING', 'COMPENSATING', 'IN_PROGRESS'),
              lease_owner = ?,
              lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND),
              attempt_count = attempt_count + 1
        WHERE id IN (?)`,
      [instanceId, leaseTtlMs * 1000, ids],
    );

    return rows.map(toClaimedOrder);
  });
}

/**
 * Push this order's lease further out while we're still working on it.
 *
 * Without a heartbeat, an order that legitimately runs longer than the TTL
 * (slow service + retries + backoff) has its lease expire while the worker is
 * alive and mid-flight. Another instance then claims the same order and you
 * have two coordinators driving it — the exact double-execution the design
 * exists to prevent.
 *
 * `AND lease_owner = ?` is the fence: an instance that already lost the lease
 * cannot renew it, and gets `false` back so it can abandon the order.
 */
export async function renewLease(
  pool: Pool,
  orderId: string,
  instanceId: string,
  leaseTtlMs: number,
): Promise<boolean> {
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE saga_orders
        SET lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND)
      WHERE order_id = ? AND lease_owner = ?`,
    [leaseTtlMs * 1000, orderId, instanceId],
  );
  return res.affectedRows === 1;
}

/**
 * Terminal (or phase) status update, fenced on lease ownership so a zombie
 * worker cannot overwrite the result produced by whoever took over.
 */
export async function setOrderStatus(
  pool: Pool,
  orderId: string,
  instanceId: string,
  status: OrderStatus,
  options: { clearLease?: boolean; lastError?: string | null } = {},
): Promise<boolean> {
  const clearLease = options.clearLease ?? false;
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE saga_orders
        SET status = ?,
            last_error = ?,
            lease_owner = ${clearLease ? 'NULL' : 'lease_owner'},
            lease_expires_at = ${clearLease ? 'NULL' : 'lease_expires_at'}
      WHERE order_id = ? AND lease_owner = ?`,
    [status, options.lastError ?? null, orderId, instanceId],
  );
  return res.affectedRows === 1;
}

/**
 * Create the step rows for a phase, or reset them for a fresh attempt.
 *
 * INSERT ... ON DUPLICATE KEY UPDATE is one atomic round trip that both
 * creates the row on first run and re-arms it on a recovery run, with no
 * read-then-write race. Rows that already SUCCEEDED are left alone — that is
 * what stops a recovered order from re-executing a step that already
 * completed before the crash.
 */
export async function initSteps(
  pool: Pool,
  orderId: string,
  steps: readonly Step[],
): Promise<void> {
  if (steps.length === 0) return;

  const values = steps.map(() => '(?,?,?,?,?)').join(',');
  const params = steps.flatMap((step) => [
    orderId,
    step,
    stepKind(step),
    'PENDING',
    idempotencyKey(orderId, step),
  ]);

  await pool.query<ResultSetHeader>(
    `INSERT INTO saga_steps (order_id, step, kind, status, idempotency_key)
     VALUES ${values}
     ON DUPLICATE KEY UPDATE
       status = IF(saga_steps.status = 'SUCCEEDED', 'SUCCEEDED', 'PENDING')`,
    params,
  );
}

export async function markStepRunning(pool: Pool, orderId: string, step: Step): Promise<void> {
  await pool.query<ResultSetHeader>(
    `UPDATE saga_steps
        SET status = 'RUNNING', started_at = COALESCE(started_at, NOW(3))
      WHERE order_id = ? AND step = ? AND status <> 'SUCCEEDED'`,
    [orderId, step],
  );
}

export async function markStepResult(
  pool: Pool,
  orderId: string,
  step: Step,
  status: StepStatus,
  options: { attempts?: number; lastError?: string | null } = {},
): Promise<void> {
  await pool.query<ResultSetHeader>(
    `UPDATE saga_steps
        SET status = ?,
            attempts = GREATEST(attempts, ?),
            last_error = ?,
            finished_at = NOW(3)
      WHERE order_id = ? AND step = ?`,
    [status, options.attempts ?? 0, options.lastError ?? null, orderId, step],
  );
}

/** One row per individual try — requirement 8's "and any retries". */
export async function recordAttempt(
  pool: Pool,
  orderId: string,
  step: Step,
  info: AttemptInfo,
): Promise<void> {
  await pool.query<ResultSetHeader>(
    `INSERT INTO saga_step_attempts
       (order_id, step, attempt_no, outcome, error_message, duration_ms, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      step,
      info.attempt,
      info.outcome,
      info.error instanceof Error ? info.error.message.slice(0, 1000) : null,
      info.durationMs,
      info.startedAt,
      info.finishedAt,
    ],
  );
}

/**
 * WHICH STEPS NEED UNDOING.
 *
 * Because the four forward steps run in parallel, when one fails we cannot
 * infer from ordering which others completed — a shipment may have succeeded a
 * millisecond before the payment failed, or not at all. So compensation is
 * driven entirely by what was recorded:
 *
 *   compensate step X  <=>  X's FORWARD row is SUCCEEDED
 *
 * That is requirement 3's "only steps that actually finished are undone",
 * expressed as a query rather than as an assumption.
 */
export async function getSucceededForwardSteps(
  pool: Pool,
  orderId: string,
): Promise<ForwardStep[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT step FROM saga_steps
      WHERE order_id = ? AND kind = 'FORWARD' AND status = 'SUCCEEDED'`,
    [orderId],
  );
  return rows.map((r) => r['step'] as ForwardStep);
}

/** Used on recovery to skip forward steps that finished before the crash. */
export async function getStepStatuses(
  pool: Pool,
  orderId: string,
): Promise<Map<Step, StepStatus>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT step, status FROM saga_steps WHERE order_id = ?`,
    [orderId],
  );
  return new Map(rows.map((r) => [r['step'] as Step, r['status'] as StepStatus]));
}

export type { PoolConnection };
