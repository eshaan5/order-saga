/**
 * Read-side queries for the Angular UI, plus the two guarded state changes it
 * can trigger (Retry and Mark Shipped).
 */

import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { OrderStatus } from '@saga/shared';
import type { ClaimedOrder } from './repository';

export interface OrderListItem {
  orderId: string;
  sku: string;
  qty: number;
  amount: string;
  status: OrderStatus;
  stepsDone: number;
  stepsTotal: number;
  updatedAt: string;
}

export interface OrderListPage {
  items: OrderListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Paginated list. Served by the (status, id) composite index.
 *
 * NOTE ON OFFSET: `LIMIT ? OFFSET ?` degrades on deep pages because MySQL must
 * walk and discard every skipped row — page 10,000 reads 500,000 rows to
 * return 50. It's the right call here because the UI needs jump-to-page and
 * a total count. Keyset pagination (`WHERE id < ?`) is the fix if this ever
 * needs to scroll through millions; noted in the README as a known limit.
 */
export async function listOrders(
  pool: Pool,
  options: { status?: OrderStatus; page: number; pageSize: number },
): Promise<OrderListPage> {
  const { page, pageSize } = options;
  const offset = (page - 1) * pageSize;

  const where = options.status ? 'WHERE o.status = ?' : '';
  const whereParams = options.status ? [options.status] : [];

  const [countRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM saga_orders o ${where}`,
    whereParams,
  );
  const total = Number(countRows[0]?.['total'] ?? 0);

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT o.order_id, o.sku, o.qty, o.amount, o.status, o.updated_at,
            (SELECT COUNT(*) FROM saga_steps s
              WHERE s.order_id = o.order_id AND s.status = 'SUCCEEDED') AS steps_done,
            (SELECT COUNT(*) FROM saga_steps s WHERE s.order_id = o.order_id) AS steps_total
       FROM saga_orders o
       ${where}
      ORDER BY o.id DESC
      LIMIT ? OFFSET ?`,
    [...whereParams, pageSize, offset],
  );

  return {
    items: rows.map((r) => ({
      orderId: String(r['order_id']),
      sku: String(r['sku']),
      qty: Number(r['qty']),
      amount: String(r['amount']),
      status: r['status'] as OrderStatus,
      stepsDone: Number(r['steps_done']),
      stepsTotal: Number(r['steps_total']),
      updatedAt: new Date(r['updated_at'] as string).toISOString(),
    })),
    total,
    page,
    pageSize,
  };
}

/** Full history for one order: the order, its 8 step rows, every attempt. */
export async function getOrderDetail(pool: Pool, orderId: string): Promise<unknown | null> {
  const [orderRows] = await pool.query<RowDataPacket[]>(
    `SELECT order_id, sku, qty, amount, status, fail_at, comp_fail_at,
            attempt_count, lease_owner, lease_expires_at, last_error,
            created_at, updated_at
       FROM saga_orders WHERE order_id = ?`,
    [orderId],
  );
  const order = orderRows[0];
  if (!order) return null;

  const [steps] = await pool.query<RowDataPacket[]>(
    `SELECT step, kind, status, attempts, idempotency_key, last_error,
            started_at, finished_at
       FROM saga_steps
      WHERE order_id = ?
      ORDER BY FIELD(kind,'FORWARD','COMPENSATION'), step`,
    [orderId],
  );

  const [attempts] = await pool.query<RowDataPacket[]>(
    `SELECT step, attempt_no, outcome, error_message, duration_ms,
            started_at, finished_at
       FROM saga_step_attempts
      WHERE order_id = ?
      ORDER BY started_at, attempt_no`,
    [orderId],
  );

  return { order, steps, attempts };
}

/** Status counts — the acceptance check (expect 2319 / 164 / 17 after a run). */
export async function getStats(pool: Pool): Promise<Record<string, number>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS count FROM saga_orders GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [String(r['status']), Number(r['count'])]));
}

/**
 * Take ownership of a NEEDS_ATTENTION order so its compensation can be re-run.
 *
 * Guarded on `status = 'NEEDS_ATTENTION'`, so two people hammering the Retry
 * button produce exactly one retry: the first UPDATE matches, the second
 * matches zero rows because the status has already moved on.
 */
export async function claimForRetry(
  pool: Pool,
  orderId: string,
  instanceId: string,
  leaseTtlMs: number,
): Promise<ClaimedOrder | null> {
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE saga_orders
        SET status = 'COMPENSATING',
            lease_owner = ?,
            lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? MICROSECOND)
      WHERE order_id = ? AND status = 'NEEDS_ATTENTION'`,
    [instanceId, leaseTtlMs * 1000, orderId],
  );
  if (res.affectedRows !== 1) return null;

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, order_id, sku, qty, amount, fail_at, comp_fail_at, status
       FROM saga_orders WHERE order_id = ?`,
    [orderId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: Number(row['id']),
    orderId: String(row['order_id']),
    sku: String(row['sku']),
    qty: Number(row['qty']),
    amount: String(row['amount']),
    failAt: (row['fail_at'] as string | null) ?? null,
    compFailAt: (row['comp_fail_at'] as string | null) ?? null,
    status: 'COMPENSATING',
  };
}

/**
 * Mark a placed order as shipped. Guarded on status='PLACED' so only a
 * genuinely placed order can be shipped, and shipping it twice is a no-op.
 * This is the ONLY thing that produces SHIPPED — nothing in the saga does.
 */
export async function markShipped(pool: Pool, orderId: string): Promise<boolean> {
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE saga_orders SET status = 'SHIPPED'
      WHERE order_id = ? AND status = 'PLACED'`,
    [orderId],
  );
  return res.affectedRows === 1;
}
