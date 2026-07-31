/**
 * Payment service — owns svc_payment.
 *
 *   POST /charge-payment   take the money
 *   POST /refund-payment   give it back
 *
 * This is the service the whole idempotency design exists for. Every other
 * step being done twice is recoverable; charging a customer twice is not.
 */

import { createPool, createServiceApp, envInt, registerStep } from '@saga/shared';
import type { ResultSetHeader } from 'mysql2/promise';

const pool = createPool('svc_payment');
const { app, logger, cache, start } = createServiceApp('payment', pool);

registerStep(app, {
  pool,
  cache,
  step: 'CHARGE_PAYMENT',
  logger,
  handler: async ({ conn, body }) => {
    // `amount` stays a string the entire way from MySQL DECIMAL through the
    // coordinator to here, and back into DECIMAL. It is never converted to a
    // JS number, because IEEE-754 doubles cannot represent decimal fractions
    // exactly and money is the one place that matters.
    await conn.execute(
      `INSERT INTO payments (order_id, amount, status)
       VALUES (?, ?, 'CHARGED')`,
      [body.orderId, body.amount],
    );
    return { orderId: body.orderId, amount: body.amount, status: 'CHARGED' };
  },
});

registerStep(app, {
  pool,
  cache,
  step: 'REFUND_PAYMENT',
  logger,
  handler: async ({ conn, body }) => {
    // Guarded on status='CHARGED': a second refund matches zero rows and
    // returns changed:false instead of moving money again.
    //
    // Note this is a compensation, not a rollback. The charge genuinely
    // happened and stays in the record with its charged_at timestamp; the
    // refund is a second event that reverses it. That asymmetry is inherent
    // to sagas — you cannot un-charge a card, you can only refund it.
    const [res] = await conn.execute<ResultSetHeader>(
      `UPDATE payments
          SET status = 'REFUNDED', refunded_at = NOW(3)
        WHERE order_id = ? AND status = 'CHARGED'`,
      [body.orderId],
    );
    return {
      orderId: body.orderId,
      status: 'REFUNDED',
      changed: res.affectedRows === 1,
    };
  },
});

start(envInt('PAYMENT_PORT', 3003));
