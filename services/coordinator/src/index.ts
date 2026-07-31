/**
 * Coordinator entry point — starts the claim loop and the read API together.
 */

import { createLogger, createPool } from '@saga/shared';
import { createApi } from './api';
import { config } from './config';
import { startWorker } from './worker';
import type { SagaDeps } from './saga';

const logger = createLogger('coordinator', { instanceId: config.instanceId });
const pool = createPool('saga');

const deps: SagaDeps = {
  pool,
  logger,
  instanceId: config.instanceId,
  serviceUrls: config.serviceUrls,
  step: config.step,
  lease: { ttlMs: config.claim.leaseTtlMs, heartbeatMs: config.claim.heartbeatMs },
};

const worker = startWorker(deps, {
  batchSize: config.claim.batchSize,
  concurrency: config.claim.concurrency,
  pollIntervalMs: config.claim.pollIntervalMs,
  leaseTtlMs: config.claim.leaseTtlMs,
});

const server = createApi(deps, logger).listen(config.port, () => {
  logger.info('coordinator listening', { port: config.port });
});

/**
 * Graceful shutdown. This is what makes the "restart mid-run" demo clean:
 * we stop claiming new work and let in-flight orders reach a terminal state.
 *
 * Anything still unfinished keeps its lease, goes stale, and is reclaimed by
 * whichever instance starts next. A SIGKILL (no graceful path at all) also
 * works — it just means waiting out the lease instead of finishing cleanly.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info('shutting down', { signal });
  server.close();
  await worker.stop();
  await pool.end();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
