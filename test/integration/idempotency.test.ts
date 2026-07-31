/**
 * Requirement 5, tested at the service boundary over real HTTP.
 *
 * saga.test.ts proves the coordinator doesn't repeat work. This proves the
 * services are safe even when the coordinator DOES call twice — which is the
 * case that actually happens in production, when a reply is lost and the
 * retry arrives at a service that already did the work.
 *
 * REQUIRES: docker compose up -d, and the four services running.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@saga/shared';
import type { Pool, RowDataPacket } from 'mysql2/promise';

const PAYMENT = 'http://127.0.0.1:3003';
const RUN = `I${Date.now().toString(36).toUpperCase()}`;

let paymentPool: Pool;

beforeAll(() => {
  paymentPool = createPool('svc_payment');
});

afterAll(async () => {
  await paymentPool.query('DELETE FROM payments WHERE order_id LIKE ?', [`${RUN}%`]);
  await paymentPool.query('DELETE FROM idempotency_records WHERE order_id LIKE ?', [`${RUN}%`]);
  await paymentPool.end();
});

function charge(orderId: string, extra: Record<string, unknown> = {}) {
  return fetch(`${PAYMENT}/charge-payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, sku: 'WIDGET-A', qty: 1, amount: '42.50', ...extra }),
  });
}

async function paymentCount(orderId: string): Promise<number> {
  const [rows] = await paymentPool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS c FROM payments WHERE order_id = ?',
    [orderId],
  );
  return Number(rows[0]?.['c'] ?? 0);
}

describe('service idempotency', () => {
  it('replays the stored response instead of charging twice', async () => {
    const orderId = `${RUN}-REPLAY`;

    const first = await charge(orderId);
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.replayed).toBe(false);

    const second = await charge(orderId);
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    // The whole point: the retry SUCCEEDS rather than erroring. If it failed,
    // the coordinator would compensate an order that was actually fine.
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.data).toEqual(firstBody.data);

    expect(await paymentCount(orderId)).toBe(1);
  });

  it('survives ten simultaneous identical requests', async () => {
    // The sequential case is easy. This is the real one: ten requests racing
    // with no ordering at all. Exactly one may execute; the rest must either
    // replay a stored result or be told to come back (409), and NONE may
    // charge a second time.
    const orderId = `${RUN}-RACE`;

    const responses = await Promise.all(Array.from({ length: 10 }, () => charge(orderId)));
    const bodies = await Promise.all(
      responses.map(async (r) => ({ status: r.status, body: await r.json() })),
    );

    const executed = bodies.filter((b) => b.status === 200 && b.body.replayed === false);
    const replayed = bodies.filter((b) => b.status === 200 && b.body.replayed === true);
    const inProgress = bodies.filter((b) => b.status === 409);

    expect(executed).toHaveLength(1);
    expect(replayed.length + inProgress.length).toBe(9);

    // The assertion that actually matters.
    expect(await paymentCount(orderId)).toBe(1);
  });

  it('does not leave a poisoned marker when the work fails', async () => {
    // A failed attempt must release its IN_PROGRESS claim. Otherwise a step
    // that fails once would block its own retries until the claim went stale,
    // turning a transient blip into a guaranteed cancellation.
    const orderId = `${RUN}-FAILTHENOK`;

    const failed = await charge(orderId, { failAt: 'CHARGE_PAYMENT' });
    expect(failed.status).toBe(500);
    expect(await paymentCount(orderId)).toBe(0);

    // Same key, no injected failure — must go through cleanly.
    const ok = await charge(orderId);
    const body = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.replayed).toBe(false);
    expect(await paymentCount(orderId)).toBe(1);
  });
});

describe('inventory release gate', () => {
  it('refuses to invent stock for an order that never reserved', async () => {
    // The naive compensation is `available_qty += qty`. Run it for an order
    // that never reserved and you have created inventory that does not exist,
    // silently and permanently. The reservation row is the gate that prevents it.
    const inventoryPool = createPool('svc_inventory');
    try {
      const [before] = await inventoryPool.query<RowDataPacket[]>(
        `SELECT available_qty FROM inventory WHERE sku = 'WIDGET-A'`,
      );

      const res = await fetch('http://127.0.0.1:3002/release-inventory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orderId: `${RUN}-NEVER-RESERVED`,
          sku: 'WIDGET-A',
          qty: 500,
          amount: '0',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.released).toBe(false);

      const [after] = await inventoryPool.query<RowDataPacket[]>(
        `SELECT available_qty FROM inventory WHERE sku = 'WIDGET-A'`,
      );
      expect(Number(after[0]?.['available_qty'])).toBe(Number(before[0]?.['available_qty']));
    } finally {
      await inventoryPool.end();
    }
  });
});
