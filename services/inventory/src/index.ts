/**
 * Inventory service — owns svc_inventory.
 *
 *   POST /reserve-inventory   set the items aside
 *   POST /release-inventory   put them back
 *
 * This is the service where getting the SQL wrong silently corrupts data
 * rather than throwing, so both handlers are written defensively.
 */

import { BusinessRuleError, createPool, createServiceApp, envInt, registerStep } from '@saga/shared';
import type { ResultSetHeader } from 'mysql2/promise';

const pool = createPool('svc_inventory');
const { app, logger, cache, start } = createServiceApp('inventory', pool);

registerStep(app, {
  pool,
  cache,
  step: 'RESERVE_INVENTORY',
  logger,
  handler: async ({ conn, body }) => {
    // ATOMIC CHECK-AND-DECREMENT.
    //
    // The `available_qty >= ?` guard and the subtraction are ONE statement, so
    // two concurrent orders for the last unit cannot both pass the check.
    // Doing this as SELECT-then-UPDATE would oversell under load, and the bug
    // would be invisible in single-threaded testing.
    const [upd] = await conn.execute<ResultSetHeader>(
      `UPDATE inventory
          SET available_qty = available_qty - ?,
              reserved_qty  = reserved_qty  + ?
        WHERE sku = ? AND available_qty >= ?`,
      [body.qty, body.qty, body.sku, body.qty],
    );

    if (upd.affectedRows === 0) {
      // Either the SKU doesn't exist or there isn't enough stock. Neither is
      // fixed by retrying, so this maps to 422 (non-retryable) and the
      // coordinator moves straight to compensating the other steps.
      throw new BusinessRuleError(`insufficient stock for ${body.sku} (requested ${body.qty})`);
    }

    await conn.execute(
      `INSERT INTO reservations (order_id, sku, qty, status)
       VALUES (?, ?, ?, 'RESERVED')`,
      [body.orderId, body.sku, body.qty],
    );

    return { orderId: body.orderId, sku: body.sku, qty: body.qty, status: 'RESERVED' };
  },
});

registerStep(app, {
  pool,
  cache,
  step: 'RELEASE_INVENTORY',
  logger,
  handler: async ({ conn, body }) => {
    // THE RESERVATION ROW IS THE GATE.
    //
    // The naive compensation is `available_qty += qty`, which is wrong: run it
    // twice, or for an order that never reserved, and you have invented stock
    // that does not physically exist. Nothing in the system would ever detect
    // it — inventory just quietly drifts upward.
    //
    // So we flip the reservation FIRST and only add stock back if that flip
    // actually changed a row. The UNIQUE(order_id) on reservations plus the
    // status guard makes a second call a no-op.
    const [released] = await conn.execute<ResultSetHeader>(
      `UPDATE reservations
          SET status = 'RELEASED', released_at = NOW(3)
        WHERE order_id = ? AND status = 'RESERVED'`,
      [body.orderId],
    );

    if (released.affectedRows === 0) {
      return { orderId: body.orderId, released: false, reason: 'no active reservation' };
    }

    await conn.execute(
      `UPDATE inventory
          SET available_qty = available_qty + ?,
              reserved_qty  = reserved_qty  - ?
        WHERE sku = ?`,
      [body.qty, body.qty, body.sku],
    );

    return { orderId: body.orderId, sku: body.sku, qty: body.qty, released: true };
  },
});

start(envInt('INVENTORY_PORT', 3002));
