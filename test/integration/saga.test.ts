/**
 * The three behaviours the assignment asks to be tested:
 *
 *   1. all steps succeed
 *   2. a step fails and everything is undone
 *   3. nothing is done twice
 *
 * Plus the subtle one that is easy to get wrong: only the steps that ACTUALLY
 * finished get undone.
 *
 * REQUIRES: docker compose up -d, and the four services running.
 *   npm run build && npm run dev:services
 *
 * These drive the real saga engine against the real services and a real
 * database. A mocked version of this would pass while the system was broken —
 * every bug worth catching here lives in the SQL or the HTTP behaviour.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, createPool } from '@saga/shared';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { runSaga, type SagaDeps } from '../../services/coordinator/src/saga';
import type { ClaimedOrder } from '../../services/coordinator/src/repository';

const INSTANCE = 'test-runner';
// Unique per run, so repeated runs never collide on order_id.
const RUN = `T${Date.now().toString(36).toUpperCase()}`;

let pool: Pool;
let paymentPool: Pool;
let inventoryPool: Pool;
let deps: SagaDeps;

beforeAll(() => {
  pool = createPool('saga');
  paymentPool = createPool('svc_payment');
  inventoryPool = createPool('svc_inventory');

  deps = {
    pool,
    // Run with LOG_LEVEL=error to quiet these down.
    logger: createLogger('test'),
    instanceId: INSTANCE,
    serviceUrls: {
      order: 'http://127.0.0.1:3001',
      inventory: 'http://127.0.0.1:3002',
      payment: 'http://127.0.0.1:3003',
      shipping: 'http://127.0.0.1:3004',
    },
    // Short backoff so the tests aren't dominated by sleeping.
    step: { timeoutMs: 5000, maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
    lease: { ttlMs: 60_000, heartbeatMs: 30_000 },
  };
});

afterAll(async () => {
  await pool.query('DELETE FROM saga_orders WHERE order_id LIKE ?', [`${RUN}%`]);
  await Promise.all([pool.end(), paymentPool.end(), inventoryPool.end()]);
});

/**
 * Insert an order already claimed by this test runner.
 *
 * lease_owner MUST be our instance id: every status write is fenced with
 * `WHERE lease_owner = ?` so a zombie worker can't clobber a result. Seed it
 * wrong and runSaga silently updates zero rows.
 */
async function seed(suffix: string, over: Partial<ClaimedOrder> = {}): Promise<ClaimedOrder> {
  const order: ClaimedOrder = {
    id: 0,
    orderId: `${RUN}-${suffix}`,
    sku: 'WIDGET-A',
    qty: 1,
    amount: '10.00',
    failAt: null,
    compFailAt: null,
    status: 'IN_PROGRESS',
    ...over,
  };

  await pool.query(
    `INSERT INTO saga_orders
       (order_id, sku, qty, amount, fail_at, comp_fail_at, status, lease_owner, lease_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, DATE_ADD(NOW(3), INTERVAL 5 MINUTE))`,
    [order.orderId, order.sku, order.qty, order.amount, order.failAt, order.compFailAt, INSTANCE],
  );

  return order;
}

async function stepStatuses(orderId: string): Promise<Record<string, string>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT step, status FROM saga_steps WHERE order_id = ?`,
    [orderId],
  );
  return Object.fromEntries(rows.map((r) => [String(r['step']), String(r['status'])]));
}

async function orderStatus(orderId: string): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT status FROM saga_orders WHERE order_id = ?`,
    [orderId],
  );
  return String(rows[0]?.['status']);
}

async function countRows(p: Pool, sql: string, orderId: string): Promise<number> {
  const [rows] = await p.query<RowDataPacket[]>(sql, [orderId]);
  return Number(rows[0]?.['c'] ?? 0);
}

describe('saga — all steps succeed', () => {
  it('places the order and marks all four forward steps SUCCEEDED', async () => {
    const order = await seed('OK');

    const status = await runSaga(deps, order);

    expect(status).toBe('PLACED');
    expect(await orderStatus(order.orderId)).toBe('PLACED');

    const steps = await stepStatuses(order.orderId);
    expect(steps['CREATE_ORDER']).toBe('SUCCEEDED');
    expect(steps['RESERVE_INVENTORY']).toBe('SUCCEEDED');
    expect(steps['CHARGE_PAYMENT']).toBe('SUCCEEDED');
    expect(steps['CREATE_SHIPMENT']).toBe('SUCCEEDED');

    // No compensation rows at all — nothing was rolled back.
    expect(steps['REFUND_PAYMENT']).toBeUndefined();
  });
});

describe('saga — a step fails and everything is undone', () => {
  it('cancels the order and compensates ONLY the steps that succeeded', async () => {
    // Payment fails on purpose. The other three succeed, so exactly those
    // three must be undone — and CANCEL_PAYMENT's counterpart REFUND_PAYMENT
    // must be SKIPPED, because the charge never happened.
    const order = await seed('FAILPAY', { failAt: 'CHARGE_PAYMENT' });

    const status = await runSaga(deps, order);

    expect(status).toBe('CANCELLED');
    expect(await orderStatus(order.orderId)).toBe('CANCELLED');

    const steps = await stepStatuses(order.orderId);

    expect(steps['CHARGE_PAYMENT']).toBe('FAILED');
    expect(steps['CREATE_ORDER']).toBe('SUCCEEDED');
    expect(steps['RESERVE_INVENTORY']).toBe('SUCCEEDED');
    expect(steps['CREATE_SHIPMENT']).toBe('SUCCEEDED');

    // The three that finished are undone...
    expect(steps['CANCEL_ORDER']).toBe('SUCCEEDED');
    expect(steps['RELEASE_INVENTORY']).toBe('SUCCEEDED');
    expect(steps['CANCEL_SHIPMENT']).toBe('SUCCEEDED');

    // ...and the one whose forward step never succeeded is NOT run.
    // This is requirement 3's "only steps that actually finished are undone".
    expect(steps['REFUND_PAYMENT']).toBe('SKIPPED');

    // And no payment was actually taken.
    const payments = await countRows(
      paymentPool,
      'SELECT COUNT(*) AS c FROM payments WHERE order_id = ?',
      order.orderId,
    );
    expect(payments).toBe(0);
  });

  it('returns the reserved stock to inventory', async () => {
    const [before] = await inventoryPool.query<RowDataPacket[]>(
      `SELECT available_qty FROM inventory WHERE sku = 'WIDGET-A'`,
    );
    const startQty = Number(before[0]?.['available_qty']);

    const order = await seed('STOCK', { failAt: 'CHARGE_PAYMENT', qty: 7 });
    await runSaga(deps, order);

    const [after] = await inventoryPool.query<RowDataPacket[]>(
      `SELECT available_qty FROM inventory WHERE sku = 'WIDGET-A'`,
    );
    // Reserved 7, then released 7 — net zero. If RELEASE_INVENTORY were
    // written as a bare `available_qty += qty` this would still pass, which
    // is why the "release without a reservation" case is tested separately.
    expect(Number(after[0]?.['available_qty'])).toBe(startQty);
  });
});

describe('saga — an undo that keeps failing', () => {
  it('flags the order NEEDS_ATTENTION rather than dropping it silently', async () => {
    // Requirement 7. Payment succeeds, shipping fails, so the refund runs —
    // and the refund is rigged to fail every attempt.
    const order = await seed('NEEDATT', {
      failAt: 'CREATE_SHIPMENT',
      compFailAt: 'REFUND_PAYMENT',
    });

    const status = await runSaga(deps, order);

    expect(status).toBe('NEEDS_ATTENTION');
    expect(await orderStatus(order.orderId)).toBe('NEEDS_ATTENTION');

    const steps = await stepStatuses(order.orderId);
    expect(steps['REFUND_PAYMENT']).toBe('FAILED');
    // The other compensations still went through — one failure doesn't
    // abandon the rest.
    expect(steps['CANCEL_ORDER']).toBe('SUCCEEDED');
    expect(steps['RELEASE_INVENTORY']).toBe('SUCCEEDED');
  });
});

describe('saga — nothing is done twice', () => {
  it('re-running a completed order does not repeat any step', async () => {
    // This is the restart case: a coordinator crashes after finishing the
    // work, and the order is reclaimed and driven again. The services must
    // replay their stored results rather than charging a second time.
    const order = await seed('TWICE');

    await runSaga(deps, order);

    const paymentsAfterFirst = await countRows(
      paymentPool,
      'SELECT COUNT(*) AS c FROM payments WHERE order_id = ?',
      order.orderId,
    );
    expect(paymentsAfterFirst).toBe(1);

    // Re-arm the lease and run the whole saga again from scratch.
    await pool.query(
      `UPDATE saga_orders
          SET status = 'IN_PROGRESS',
              lease_owner = ?,
              lease_expires_at = DATE_ADD(NOW(3), INTERVAL 5 MINUTE)
        WHERE order_id = ?`,
      [INSTANCE, order.orderId],
    );

    const status = await runSaga(deps, { ...order, status: 'IN_PROGRESS' });
    expect(status).toBe('PLACED');

    // STILL exactly one payment. The idempotency records replayed instead of
    // re-executing.
    const paymentsAfterSecond = await countRows(
      paymentPool,
      'SELECT COUNT(*) AS c FROM payments WHERE order_id = ?',
      order.orderId,
    );
    expect(paymentsAfterSecond).toBe(1);

    // And exactly one reservation.
    const reservations = await countRows(
      inventoryPool,
      'SELECT COUNT(*) AS c FROM reservations WHERE order_id = ?',
      order.orderId,
    );
    expect(reservations).toBe(1);
  });
});
