/**
 * All coordinator tuning in one place, read once at startup so a bad value
 * crashes immediately rather than forty minutes into a bulk run.
 */

import { envInt, envStr, type ServiceName } from '@saga/shared';
import { hostname } from 'node:os';

export const config = {
  port: envInt('COORDINATOR_PORT', 3000),

  /** Where each worker service lives. */
  serviceUrls: {
    order: envStr('ORDER_URL', 'http://127.0.0.1:3001'),
    inventory: envStr('INVENTORY_URL', 'http://127.0.0.1:3002'),
    payment: envStr('PAYMENT_URL', 'http://127.0.0.1:3003'),
    shipping: envStr('SHIPPING_URL', 'http://127.0.0.1:3004'),
  } satisfies Record<ServiceName, string>,

  /** Requirement 4 — per-attempt time limit and retry budget. */
  step: {
    timeoutMs: envInt('STEP_TIMEOUT_MS', 3000),
    maxAttempts: envInt('STEP_MAX_ATTEMPTS', 3),
    baseDelayMs: envInt('STEP_BASE_DELAY_MS', 100),
    maxDelayMs: envInt('STEP_MAX_DELAY_MS', 2000),
  },

  /** The claim loop. */
  claim: {
    batchSize: envInt('CLAIM_BATCH_SIZE', 50),
    concurrency: envInt('ORDER_CONCURRENCY', 25),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 500),
    leaseTtlMs: envInt('LEASE_TTL_MS', 60_000),
    heartbeatMs: envInt('LEASE_HEARTBEAT_MS', 20_000),
  },

  /** Rows buffered before one multi-row INSERT. A CONSTANT, never the file
   *  size — this value IS the ingest memory ceiling. */
  ingestBatchSize: envInt('INGEST_BATCH_SIZE', 500),

  /**
   * Identifies this process in `saga_orders.lease_owner`.
   *
   * Two jobs: it answers "which instance is stuck on this order?" when you're
   * debugging, and it acts as a fencing token — every write is guarded
   * `WHERE lease_owner = ?`, so a worker that stalled past its lease and woke
   * up late updates zero rows instead of clobbering the instance that took
   * over.
   *
   * Randomised suffix so two containers on the same host don't collide.
   */
  instanceId: `coord-${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
} as const;
