/**
 * Notification service entry point.
 *
 * Deliberately outside the saga: it never touches saga_orders, is not called
 * by the coordinator, and its failure cannot affect order processing.
 *
 *   GET  /health
 *   GET  /api/notifications        recent notification records
 *   POST /api/notifications/run    trigger the job now (so a demo doesn't
 *                                  have to wait 15 minutes)
 */

import { createLogger, createPool, envInt, envStr } from '@saga/shared';
import express, { type Request, type Response } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import { hostname } from 'node:os';
import cron from 'node-cron';
import { runNotificationJob, type NotifierDeps } from './notifier';

const instanceId = `notif-${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const logger = createLogger('notification', { instanceId });
const pool = createPool('svc_notification');

const deps: NotifierDeps = {
  pool,
  logger,
  instanceId,
  coordinatorUrl: envStr('COORDINATOR_URL', 'http://127.0.0.1:3000'),
  batchSize: envInt('NOTIFICATION_BATCH_SIZE', 100),
  staleMs: envInt('NOTIFICATION_STALE_MS', 120_000),
};

const schedule = envStr('NOTIFICATION_CRON', '*/15 * * * *');

/**
 * Overlap guard.
 *
 * If a run takes longer than the interval, cron fires again anyway and you get
 * two concurrent jobs in the SAME process. They wouldn't double-send — the
 * unique key still holds — but they'd race on claims and waste work. Cheap to
 * prevent, so prevent it.
 *
 * Note this guard is per-process only. Correctness across INSTANCES comes from
 * the database, never from a variable in memory.
 */
let running = false;

async function tick(trigger: string): Promise<void> {
  if (running) {
    logger.warn('previous notification run still in progress, skipping', { trigger });
    return;
  }
  running = true;
  try {
    await runNotificationJob(deps);
  } catch (err) {
    // Never let a failed run kill the schedule — the next tick retries, and
    // "never missed" depends on the job continuing to run.
    logger.error('notification run failed', { trigger, error: err });
  } finally {
    running = false;
  }
}

cron.schedule(schedule, () => void tick('cron'));
logger.info('notification scheduler started', { schedule });

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  void pool
    .query('SELECT 1')
    .then(() => res.json({ ok: true, service: 'notification', instanceId, schedule }))
    .catch((err: unknown) => res.status(503).json({ ok: false, error: String(err) }));
});

app.get('/api/notifications', (req: Request, res: Response) => {
  const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 50) || 50));
  void pool
    .query<RowDataPacket[]>(
      `SELECT order_id, status, claimed_by, claimed_at, sent_at, attempts
         FROM notifications ORDER BY id DESC LIMIT ?`,
      [limit],
    )
    .then(([rows]) => res.json({ items: rows }))
    .catch((err: unknown) => res.status(500).json({ ok: false, error: String(err) }));
});

app.post('/api/notifications/run', (_req: Request, res: Response) => {
  void (async () => {
    if (running) {
      res.status(409).json({ ok: false, error: 'a run is already in progress' });
      return;
    }
    running = true;
    try {
      const result = await runNotificationJob(deps);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  })();
});

const port = envInt('NOTIFICATION_PORT', 3005);
const server = app.listen(port, () => logger.info('notification listening', { port }));

async function shutdown(signal: string): Promise<void> {
  logger.info('shutting down', { signal });
  server.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
