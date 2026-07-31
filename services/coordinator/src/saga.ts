/**
 * The saga engine — one order, start to finish.
 *
 *   1. fire all four forward steps AT THE SAME TIME
 *   2. all four succeed              -> PLACED
 *   3. any one fails                 -> undo the ones that actually succeeded
 *   4. all undos succeed             -> CANCELLED
 *      an undo exhausts its retries  -> NEEDS_ATTENTION
 */

import {
  COMPENSATION_OF,
  COMPENSATION_STEPS,
  FORWARD_STEPS,
  STEP_SERVICE,
  callStep,
  type ForwardStep,
  type Logger,
  type OrderStatus,
  type ServiceName,
  type Step,
} from '@saga/shared';
import type { Pool } from 'mysql2/promise';
import type { ClaimedOrder } from './repository';
import {
  getStepStatuses,
  getSucceededForwardSteps,
  initSteps,
  markStepResult,
  markStepRunning,
  recordAttempt,
  renewLease,
  setOrderStatus,
} from './repository';

export interface SagaDeps {
  pool: Pool;
  logger: Logger;
  instanceId: string;
  serviceUrls: Record<ServiceName, string>;
  step: {
    timeoutMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  lease: { ttlMs: number; heartbeatMs: number };
}

interface StepOutcome {
  step: Step;
  ok: boolean;
  error?: unknown;
}

/**
 * Run one operation: mark it RUNNING, call the service with timeout + retry,
 * write an attempt row per try, then record the final result.
 *
 * Deliberately does not throw — it converts failure into a value, so the
 * caller can reason about all four outcomes together rather than having the
 * first rejection unwind everything.
 */
async function executeStep(
  deps: SagaDeps,
  order: ClaimedOrder,
  step: Step,
  options: { force?: boolean } = {},
): Promise<StepOutcome> {
  const { pool, logger } = deps;
  let attempts = 0;

  try {
    await markStepRunning(pool, order.orderId, step);

    await callStep({
      baseUrl: deps.serviceUrls[STEP_SERVICE[step]],
      step,
      body: {
        orderId: order.orderId,
        sku: order.sku,
        qty: order.qty,
        amount: order.amount,
        failAt: order.failAt,
        compFailAt: order.compFailAt,
        // Only ever true for the UI's manual retry — lets a human clear a
        // NEEDS_ATTENTION order whose compFailAt would otherwise fail forever.
        ...(options.force ? { force: true } : {}),
      },
      timeoutMs: deps.step.timeoutMs,
      maxAttempts: deps.step.maxAttempts,
      baseDelayMs: deps.step.baseDelayMs,
      maxDelayMs: deps.step.maxDelayMs,
      onAttempt: async (info) => {
        attempts = info.attempt;
        await recordAttempt(pool, order.orderId, step, info);
      },
    });

    await markStepResult(pool, order.orderId, step, 'SUCCEEDED', { attempts });
    return { step, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markStepResult(pool, order.orderId, step, 'FAILED', { attempts, lastError: message });
    logger.warn('step failed', { orderId: order.orderId, step, attempts, error: message });
    return { step, ok: false, error: err };
  }
}

/**
 * Run several operations concurrently.
 *
 * Promise.allSettled, NEVER Promise.all.
 *
 * Promise.all rejects the instant the first promise rejects and abandons the
 * other three while they are still in flight. We would then have no idea
 * whether they succeeded — and if they did, we would never compensate them.
 * That is a silent money leak that only appears under failure, which is
 * exactly when you are least able to notice it.
 *
 * allSettled waits for every branch and reports each independently.
 */
async function runConcurrently(
  deps: SagaDeps,
  order: ClaimedOrder,
  steps: readonly Step[],
  options: { force?: boolean } = {},
): Promise<StepOutcome[]> {
  const settled = await Promise.allSettled(
    steps.map((step) => executeStep(deps, order, step, options)),
  );

  return settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    // executeStep swallows service errors, so a rejection here means the
    // bookkeeping itself failed (e.g. the DB went away). Treat it as a failed
    // step so the order still reaches a terminal state instead of hanging.
    return { step: steps[i] as Step, ok: false, error: result.reason };
  });
}

/**
 * Compensation phase. Undo exactly the forward steps that SUCCEEDED —
 * read from saga_steps, never inferred from ordering.
 */
async function compensate(
  deps: SagaDeps,
  order: ClaimedOrder,
  options: { force?: boolean } = {},
): Promise<OrderStatus> {
  const { pool, logger } = deps;

  const succeeded: ForwardStep[] = await getSucceededForwardSteps(pool, order.orderId);
  const needed = new Set(succeeded.map((s) => COMPENSATION_OF[s]));

  // Create all four compensation rows so the detail page shows the complete
  // picture, then mark the unnecessary ones SKIPPED. "CANCEL_ORDER: SKIPPED"
  // is meaningful output — it says the order was never created, so there was
  // nothing to cancel.
  await initSteps(pool, order.orderId, COMPENSATION_STEPS);
  for (const step of COMPENSATION_STEPS) {
    if (!needed.has(step)) await markStepResult(pool, order.orderId, step, 'SKIPPED');
  }

  const toRun = COMPENSATION_STEPS.filter((s) => needed.has(s));
  logger.info('compensating', { orderId: order.orderId, steps: toRun });

  if (toRun.length === 0) return 'CANCELLED';

  const outcomes = await runConcurrently(deps, order, toRun, options);
  const failed = outcomes.filter((o) => !o.ok);

  if (failed.length === 0) return 'CANCELLED';

  // Requirement 7: don't drop it silently. Flag it for a human, who gets a
  // Retry button in the UI.
  logger.error('compensation exhausted retries', {
    orderId: order.orderId,
    failedSteps: failed.map((f) => f.step),
  });
  return 'NEEDS_ATTENTION';
}

/**
 * Keep the lease alive while we work, so a long-running order is not stolen
 * by another instance that mistakes slowness for death.
 */
function startHeartbeat(deps: SagaDeps, orderId: string): () => void {
  const timer = setInterval(() => {
    void renewLease(deps.pool, orderId, deps.instanceId, deps.lease.ttlMs).then((held) => {
      if (!held) {
        deps.logger.warn('lost lease while processing', { orderId, instanceId: deps.instanceId });
      }
    });
  }, deps.lease.heartbeatMs);

  // Don't let the timer keep the process alive at shutdown.
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runSaga(deps: SagaDeps, order: ClaimedOrder): Promise<OrderStatus> {
  const { pool, logger } = deps;
  const log = logger.child({ orderId: order.orderId });
  const stopHeartbeat = startHeartbeat(deps, order.orderId);

  try {
    // ---- Recovery path -----------------------------------------------------
    // Claimed in COMPENSATING means a previous coordinator died mid-rollback.
    // Resume rolling back; do NOT re-run the forward steps.
    if (order.status === 'COMPENSATING') {
      log.info('resuming compensation after recovery');
      const status = await compensate(deps, order);
      await setOrderStatus(pool, order.orderId, deps.instanceId, status, { clearLease: true });
      return status;
    }

    // ---- Forward phase -----------------------------------------------------
    await initSteps(pool, order.orderId, FORWARD_STEPS);

    // On a recovery run, steps that already SUCCEEDED before the crash are
    // left alone by initSteps and skipped here. Even if we did re-call them,
    // the services' idempotency records would replay rather than re-execute —
    // this is belt and braces, and it saves four pointless HTTP calls.
    const existing = await getStepStatuses(pool, order.orderId);
    const pending = FORWARD_STEPS.filter((s) => existing.get(s) !== 'SUCCEEDED');

    const outcomes = await runConcurrently(deps, order, pending);
    const failed = outcomes.filter((o) => !o.ok);

    if (failed.length === 0) {
      await setOrderStatus(pool, order.orderId, deps.instanceId, 'PLACED', { clearLease: true });
      log.info('order placed');
      return 'PLACED';
    }

    // ---- Compensation phase ------------------------------------------------
    // Persist COMPENSATING BEFORE starting the undos. If we crash mid-rollback,
    // the claim query finds this status and resumes here rather than replaying
    // the order forwards.
    const firstError = failed[0]?.error;
    await setOrderStatus(pool, order.orderId, deps.instanceId, 'COMPENSATING', {
      lastError: firstError instanceof Error ? firstError.message : String(firstError ?? ''),
    });

    const status = await compensate(deps, { ...order, status: 'COMPENSATING' });
    await setOrderStatus(pool, order.orderId, deps.instanceId, status, { clearLease: true });
    log.info('order finished', { status, failedSteps: failed.map((f) => f.step) });
    return status;
  } catch (err) {
    // The order keeps its lease and will be reclaimed once it expires, so an
    // unexpected crash here loses nothing.
    log.error('saga aborted unexpectedly', { error: err });
    throw err;
  } finally {
    stopHeartbeat();
  }
}

/**
 * Manual retry for a NEEDS_ATTENTION order — the UI's Retry button.
 *
 * Sends force:true so the service ignores its injected compFailAt failure.
 * Without that the button could never succeed, because the injected failure
 * fires on every single attempt by design.
 */
export async function retryCompensation(
  deps: SagaDeps,
  order: ClaimedOrder,
): Promise<OrderStatus> {
  const status = await compensate(deps, order, { force: true });
  await setOrderStatus(deps.pool, order.orderId, deps.instanceId, status, { clearLease: true });
  return status;
}
