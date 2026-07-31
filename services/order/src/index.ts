/**
 * Order service — owns svc_order.
 *
 *   POST /create-order   record the order
 *   POST /cancel-order   undo it
 */

import { createPool, createServiceApp, envInt, registerStep } from '@saga/shared';
import type { ResultSetHeader } from 'mysql2/promise';

const pool = createPool('svc_order');
const { app, logger, cache, start } = createServiceApp('order', pool);

registerStep(app, {
  pool,
  cache,
  step: 'CREATE_ORDER',
  logger,
  handler: async ({ conn, body }) => {
    await conn.execute(
      `INSERT INTO orders (order_id, sku, qty, amount, status)
       VALUES (?, ?, ?, ?, 'CREATED')`,
      [body.orderId, body.sku, body.qty, body.amount],
    );
    return { orderId: body.orderId, status: 'CREATED' };
  },
});

registerStep(app, {
  pool,
  cache,
  step: 'CANCEL_ORDER',
  logger,
  handler: async ({ conn, body }) => {
    // Guarded on status='CREATED' so running this twice is a no-op rather
    // than an error. affectedRows === 0 is a legitimate outcome (already
    // cancelled, or the create never landed) and must NOT throw — the
    // coordinator only calls a compensation when its forward step succeeded,
    // but a compensation that is safe when called spuriously is one less
    // thing that can wedge an order into NEEDS_ATTENTION.
    const [res] = await conn.execute<ResultSetHeader>(
      `UPDATE orders
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

start(envInt('ORDER_PORT', 3001));
