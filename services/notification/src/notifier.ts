/**
 * Exactly one notification per shipped order.
 *
 * THE REQUIREMENT SPLITS IN TWO, AND EACH HALF HAS ITS OWN MECHANISM:
 *
 *   "never sent twice"  ->  UNIQUE(order_id) + INSERT IGNORE.
 *                           N instances race; exactly one wins the insert.
 *
 *   "never missed"      ->  the job re-runs every 15 minutes, so anything not
 *                           yet SENT is picked up on a later cycle.
 *
 * THE GAP BETWEEN THEM is the interesting failure. Crash after claiming but
 * before sending, and the row sits CLAIMED forever: never sent, and never
 * re-claimable, because the unique key now blocks every other instance. So a
 * sweep reclaims stale CLAIMED rows — the same lease idea as saga_orders,
 * owned by notification instances instead of coordinators.
 *
 * NOTE the scheduler is NOT the guarantee. node-cron decides *when*; three
 * instances all fire at :00 and all see the same shipped orders. Correctness
 * is entirely in the database.
 */

import type { Logger } from '@saga/shared';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface NotifierDeps {
  pool: Pool;
  logger: Logger;
  instanceId: string;
  /** Shipped orders are fetched over HTTP — the notification service must not
   *  read the `saga` schema. The schema boundary is what "its own data" means. */
  coordinatorUrl: string;
  batchSize: number;
  staleMs: number;
}

export interface JobResult {
  shippedSeen: number;
  reclaimed: number;
  claimed: number;
  sent: number;
  alreadyHandled: number;
  failed: number;
}

interface OrderListResponse {
  items: Array<{ orderId: string }>;
  total: number;
  page: number;
  pageSize: number;
}

/** Page through the coordinator's list API for everything marked SHIPPED. */
async function fetchShippedOrderIds(baseUrl: string, pageSize: number): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;

  for (;;) {
    const url = `${baseUrl.replace(/\/$/, '')}/api/orders?status=SHIPPED&page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`coordinator returned HTTP ${res.status}`);

    const body = (await res.json()) as OrderListResponse;
    ids.push(...body.items.map((i) => i.orderId));

    if (page * body.pageSize >= body.total || body.items.length === 0) break;
    page++;
  }

  return ids;
}

/**
 * Take over notifications abandoned by an instance that died mid-send.
 *
 * Staleness is decided in SQL, not in JS, so check-and-takeover is one atomic
 * statement and two instances cannot both conclude "this one is mine now".
 */
async function reclaimStale(deps: NotifierDeps): Promise<string[]> {
  const staleSeconds = Math.max(1, Math.ceil(deps.staleMs / 1000));

  await deps.pool.query<ResultSetHeader>(
    `UPDATE notifications
        SET claimed_by = ?, claimed_at = NOW(3)
      WHERE status = 'CLAIMED'
        AND claimed_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)
      LIMIT ?`,
    [deps.instanceId, staleSeconds, deps.batchSize],
  );

  const [rows] = await deps.pool.query<RowDataPacket[]>(
    `SELECT order_id FROM notifications
      WHERE status = 'CLAIMED' AND claimed_by = ?
      LIMIT ?`,
    [deps.instanceId, deps.batchSize],
  );

  return rows.map((r) => String(r['order_id']));
}

/**
 * Try to claim one order. Returns true only if THIS instance won.
 *
 * INSERT IGNORE + UNIQUE(order_id) is the whole exactly-once guarantee: the
 * database serialises the race, and affectedRows is the answer.
 */
async function claim(deps: NotifierDeps, orderId: string): Promise<boolean> {
  const [res] = await deps.pool.query<ResultSetHeader>(
    `INSERT IGNORE INTO notifications (order_id, status, claimed_by, claimed_at)
     VALUES (?, 'CLAIMED', ?, NOW(3))`,
    [orderId, deps.instanceId],
  );
  return res.affectedRows === 1;
}

/**
 * "Sending" a notification. The assignment says recording that one was sent
 * is sufficient, so the UPDATE *is* the send.
 *
 * In a real system the external call would go here, and the ordering matters:
 * you send first, then mark SENT. If the process dies between them the row
 * stays CLAIMED, the sweep reclaims it, and the notification is sent twice —
 * at-least-once. Getting true exactly-once against a third party needs an
 * idempotency key on their side too. Worth stating rather than pretending the
 * problem disappears.
 */
async function send(deps: NotifierDeps, orderId: string): Promise<boolean> {
  const [res] = await deps.pool.query<ResultSetHeader>(
    `UPDATE notifications
        SET status = 'SENT', sent_at = NOW(3), attempts = attempts + 1
      WHERE order_id = ? AND status = 'CLAIMED' AND claimed_by = ?`,
    [orderId, deps.instanceId],
  );
  return res.affectedRows === 1;
}

export async function runNotificationJob(deps: NotifierDeps): Promise<JobResult> {
  const { logger } = deps;
  const result: JobResult = {
    shippedSeen: 0,
    reclaimed: 0,
    claimed: 0,
    sent: 0,
    alreadyHandled: 0,
    failed: 0,
  };

  // 1. Rescue anything a dead instance left half-done, BEFORE taking new work.
  const reclaimed = await reclaimStale(deps);
  result.reclaimed = reclaimed.length;

  // 2. Everything currently marked shipped.
  const shipped = await fetchShippedOrderIds(deps.coordinatorUrl, deps.batchSize);
  result.shippedSeen = shipped.length;

  // 3. Claim what we can. Orders already SENT are silently ignored by the
  //    unique key — no query needed to check first, which is what keeps this
  //    cheap when the job has already processed thousands of orders.
  const mine = [...reclaimed];
  for (const orderId of shipped) {
    if (await claim(deps, orderId)) {
      mine.push(orderId);
      result.claimed++;
    } else {
      result.alreadyHandled++;
    }
  }

  // 4. Send everything we own.
  for (const orderId of mine) {
    try {
      if (await send(deps, orderId)) result.sent++;
    } catch (err) {
      result.failed++;
      logger.error('notification send failed', { orderId, error: err });
      // Left CLAIMED on purpose — the sweep reclaims it on a later cycle.
    }
  }

  logger.info('notification job complete', { ...result });
  return result;
}
