/**
 * Read API + the two actions the UI can trigger.
 *
 *   GET  /api/stats                        status counts (the acceptance check)
 *   GET  /api/orders?status=&page=&size=   paginated list
 *   GET  /api/orders/:orderId              full detail incl. steps and attempts
 *   POST /api/orders/:orderId/retry        re-run a failed compensation
 *   POST /api/orders/:orderId/mark-shipped  place -> shipped
 *   POST /api/ingest                       load the CSV
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { resolve } from 'node:path';
import type { Logger, OrderStatus } from '@saga/shared';
import { config } from './config';
import { ingestOrders } from './ingest';
import {
  claimForRetry,
  getOrderDetail,
  getStats,
  listOrders,
  markShipped,
} from './queries';
import { retryCompensation, type SagaDeps } from './saga';

const VALID_STATUSES = new Set<OrderStatus>([
  'PENDING',
  'IN_PROGRESS',
  'PLACED',
  'COMPENSATING',
  'CANCELLED',
  'NEEDS_ATTENTION',
  'SHIPPED',
]);

/** Wrap an async route so a rejected promise reaches the error middleware
 *  instead of becoming an unhandled rejection. Express 4 doesn't do this. */
function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function createApi(deps: SagaDeps, logger: Logger): Express {
  const app = express();
  const { pool } = deps;

  app.use(express.json());

  // The Angular dev server runs on a different port, so the browser treats
  // these as cross-origin. Wide open because the assignment specifies no auth.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'content-type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    next();
  });
  app.options(/.*/, (_req: Request, res: Response) => res.sendStatus(204));

  app.get('/health', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'coordinator', instanceId: deps.instanceId });
  }));

  app.get('/api/stats', asyncRoute(async (_req, res) => {
    res.json(await getStats(pool));
  }));

  app.get('/api/orders', asyncRoute(async (req, res) => {
    const rawStatus = req.query['status'];
    const status =
      typeof rawStatus === 'string' && VALID_STATUSES.has(rawStatus as OrderStatus)
        ? (rawStatus as OrderStatus)
        : undefined;

    const page = Math.max(1, Number(req.query['page'] ?? 1) || 1);
    // Capped so a client can't ask for a million rows and take the API down.
    const pageSize = Math.min(200, Math.max(1, Number(req.query['pageSize'] ?? 25) || 25));

    res.json(await listOrders(pool, { ...(status ? { status } : {}), page, pageSize }));
  }));

  app.get('/api/orders/:orderId', asyncRoute(async (req, res) => {
    const detail = await getOrderDetail(pool, String(req.params['orderId']));
    if (!detail) {
      res.status(404).json({ ok: false, error: 'order not found' });
      return;
    }
    res.json(detail);
  }));

  /** Requirement 7 — the manual retry for a NEEDS_ATTENTION order. */
  app.post('/api/orders/:orderId/retry', asyncRoute(async (req, res) => {
    const orderId = String(req.params['orderId']);

    // Guarded claim: two people clicking Retry produce exactly one retry.
    const order = await claimForRetry(pool, orderId, deps.instanceId, config.claim.leaseTtlMs);
    if (!order) {
      res.status(409).json({
        ok: false,
        error: 'order is not in NEEDS_ATTENTION, or a retry is already running',
      });
      return;
    }

    logger.info('manual compensation retry', { orderId });
    const status = await retryCompensation(deps, order);
    res.json({ ok: true, orderId, status });
  }));

  app.post('/api/orders/:orderId/mark-shipped', asyncRoute(async (req, res) => {
    const orderId = String(req.params['orderId']);
    const ok = await markShipped(pool, orderId);
    if (!ok) {
      res.status(409).json({ ok: false, error: 'only a PLACED order can be marked shipped' });
      return;
    }
    res.json({ ok: true, orderId, status: 'SHIPPED' });
  }));

  app.post('/api/ingest', asyncRoute(async (req, res) => {
    const file =
      typeof req.body?.file === 'string'
        ? req.body.file
        : resolve(__dirname, '../../../data/orders_bulk.csv');

    const result = await ingestOrders(pool, file, logger, {
      batchSize: config.ingestBatchSize,
    });
    res.json({ ok: true, ...result });
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('api error', { error: err });
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'internal error' });
  });

  return app;
}
