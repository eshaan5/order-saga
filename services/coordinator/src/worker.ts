/**
 * The claim loop — poll for work, run it with bounded concurrency, repeat.
 *
 * This is the "many orders at the same time, not one after another" half of
 * the scalability requirement. The other half (multiple instances) is handled
 * entirely by SKIP LOCKED inside claimBatch.
 */

import type { Logger } from '@saga/shared';
import { claimBatch, type ClaimedOrder } from './repository';
import { runSaga, type SagaDeps } from './saga';

export interface WorkerOptions {
  batchSize: number;
  concurrency: number;
  pollIntervalMs: number;
  leaseTtlMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * NOT `Promise.all(items.map(fn))` — that would fire all 50 claimed orders at
 * once, which is 200 simultaneous HTTP calls and 50 open DB transactions. The
 * cap is what keeps the connection pool and the downstream services from
 * being the thing that breaks under a bulk load.
 *
 * Implemented as N long-lived workers pulling from a shared cursor, so a slow
 * order never blocks a free slot the way fixed-size chunking would.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

export interface Worker {
  /** Stop claiming new work and wait for in-flight orders to finish. */
  stop(): Promise<void>;
}

export function startWorker(deps: SagaDeps, options: WorkerOptions): Worker {
  const { pool, logger } = deps;
  let running = true;
  let inFlight: Promise<void> = Promise.resolve();

  async function processOne(order: ClaimedOrder): Promise<void> {
    try {
      await runSaga(deps, order);
    } catch (err) {
      // Never let one bad order kill the loop. The order keeps its lease and
      // is reclaimed automatically once that lease goes stale.
      logger.error('order processing threw', { orderId: order.orderId, error: err });
    }
  }

  async function loop(): Promise<void> {
    logger.info('worker started', { instanceId: deps.instanceId, ...options });

    while (running) {
      let batch: ClaimedOrder[] = [];
      try {
        batch = await claimBatch(pool, deps.instanceId, options.batchSize, options.leaseTtlMs);
      } catch (err) {
        // A DB blip must not kill the worker — back off and try again.
        logger.error('claim failed', { error: err });
        await sleep(options.pollIntervalMs);
        continue;
      }

      if (batch.length === 0) {
        // Nothing to do. Idle politely rather than hot-spinning on the DB.
        await sleep(options.pollIntervalMs);
        continue;
      }

      logger.info('claimed batch', { count: batch.length });
      inFlight = mapWithConcurrency(batch, options.concurrency, processOne);
      await inFlight;
    }

    logger.info('worker stopped');
  }

  void loop();

  return {
    async stop(): Promise<void> {
      // Graceful shutdown matters for the restart demo: we stop taking NEW
      // work but let in-flight orders reach a terminal state. Anything still
      // unfinished keeps its lease and is picked up by whoever starts next —
      // which is requirement 6 working exactly as designed.
      running = false;
      await inFlight;
    },
  };
}
