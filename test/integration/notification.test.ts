/**
 * "Exactly one notification is sent per shipped order — even though the job
 * runs every 15 minutes and multiple copies of the Notification service may
 * run." (Assignment, What we look at.)
 *
 * The thing under test is a DATABASE RACE, so firing N concurrent claims from
 * one process exercises the identical code path that two containers would —
 * and does it deterministically, instead of hoping the timing lines up.
 *
 * REQUIRES: docker compose up -d.  (No services needed — this is pure DB.)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@saga/shared';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

const RUN = `N${Date.now().toString(36).toUpperCase()}`;
let pool: Pool;

beforeAll(() => {
  pool = createPool('svc_notification');
});

afterAll(async () => {
  await pool.query('DELETE FROM notifications WHERE order_id LIKE ?', [`${RUN}%`]);
  await pool.end();
});

/** The exact claim the notification service performs. */
async function claim(orderId: string, instanceId: string): Promise<boolean> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT IGNORE INTO notifications (order_id, status, claimed_by, claimed_at)
     VALUES (?, 'CLAIMED', ?, NOW(3))`,
    [orderId, instanceId],
  );
  return res.affectedRows === 1;
}

async function rowCount(orderId: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS c FROM notifications WHERE order_id = ?',
    [orderId],
  );
  return Number(rows[0]?.['c'] ?? 0);
}

describe('notification exactly-once', () => {
  it('gives exactly one winner when ten instances claim the same order at once', async () => {
    const orderId = `${RUN}-RACE`;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) => claim(orderId, `instance-${i}`)),
    );

    // Exactly one instance sends. The other nine skip silently.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rowCount(orderId)).toBe(1);
  });

  it('never re-claims an order once it has been sent', async () => {
    // The scheduled job runs forever. Every subsequent cycle must be a no-op
    // for orders already handled — this is the "never sent twice" half.
    const orderId = `${RUN}-SENT`;

    expect(await claim(orderId, 'instance-a')).toBe(true);
    await pool.query(
      `UPDATE notifications SET status = 'SENT', sent_at = NOW(3) WHERE order_id = ?`,
      [orderId],
    );

    // Simulate the next twenty cron cycles across several instances.
    for (let i = 0; i < 20; i++) {
      expect(await claim(orderId, `instance-${i % 3}`)).toBe(false);
    }

    expect(await rowCount(orderId)).toBe(1);

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT status, attempts FROM notifications WHERE order_id = ?',
      [orderId],
    );
    expect(rows[0]?.['status']).toBe('SENT');
  });

  it('reclaims a notification abandoned by a dead instance', async () => {
    // The gap between "never twice" and "never missed": an instance that
    // claims and then dies leaves a row CLAIMED forever — never sent, and
    // never re-claimable, because the unique key now blocks everyone.
    const orderId = `${RUN}-STALE`;

    expect(await claim(orderId, 'dead-instance')).toBe(true);

    // Backdate the claim to look abandoned.
    await pool.query(
      `UPDATE notifications SET claimed_at = DATE_SUB(NOW(3), INTERVAL 10 MINUTE)
        WHERE order_id = ?`,
      [orderId],
    );

    // The sweep. Staleness is evaluated in SQL so check-and-takeover is one
    // atomic statement — two instances cannot both decide it's theirs.
    const [takeover] = await pool.query<ResultSetHeader>(
      `UPDATE notifications
          SET claimed_by = ?, claimed_at = NOW(3)
        WHERE status = 'CLAIMED'
          AND order_id = ?
          AND claimed_at < DATE_SUB(NOW(3), INTERVAL 120 SECOND)`,
      ['live-instance', orderId],
    );

    expect(takeover.affectedRows).toBe(1);

    // Still one row — recovery took the claim over, it didn't duplicate it.
    expect(await rowCount(orderId)).toBe(1);
  });
});
