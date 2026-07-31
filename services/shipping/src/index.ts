/**
 * Shipping service — owns svc_shipping.
 *
 *   POST /create-shipment   arrange it
 *   POST /cancel-shipment   call it off
 */

import { createPool, createServiceApp, envInt, registerStep } from '@saga/shared';
import type { ResultSetHeader } from 'mysql2/promise';

const pool = createPool('svc_shipping');
const { app, logger, cache, start } = createServiceApp('shipping', pool);

registerStep(app, {
  pool,
  cache,
  step: 'CREATE_SHIPMENT',
  logger,
  handler: async ({ conn, body }) => {
    // Tracking number is DERIVED from the order id, not random.
    //
    // If it were random, a retry after a lost reply would be caught by the
    // idempotency record and replay the FIRST tracking number — fine. But any
    // path that regenerated it would hand the coordinator a different value
    // than the one stored, and now two systems disagree about the shipment.
    // Deriving it removes the possibility entirely.
    const trackingNo = `TRK-${body.orderId}`;

    await conn.execute(
      `INSERT INTO shipments (order_id, tracking_no, status)
       VALUES (?, ?, 'CREATED')`,
      [body.orderId, trackingNo],
    );

    return { orderId: body.orderId, trackingNo, status: 'CREATED' };
  },
});

registerStep(app, {
  pool,
  cache,
  step: 'CANCEL_SHIPMENT',
  logger,
  handler: async ({ conn, body }) => {
    const [res] = await conn.execute<ResultSetHeader>(
      `UPDATE shipments
          SET status = 'CANCELLED', cancelled_at = NOW(3)
        WHERE order_id = ? AND status = 'CREATED'`,
      [body.orderId],
    );
    return {
      orderId: body.orderId,
      status: 'CANCELLED',
      changed: res.affectedRows === 1,
    };
  },
});

start(envInt('SHIPPING_PORT', 3004));
