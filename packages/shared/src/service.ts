/**
 * The Express plumbing every worker service shares.
 *
 * NOTE ON WHAT LIVES HERE: infrastructure only, never domain logic. This file
 * knows about HTTP, idempotency and error mapping; it does not know what a
 * payment or a shipment is. That line is what keeps a shared package from
 * turning four services into a distributed monolith — a pricing change should
 * never force four redeploys.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { createCache, type Cache } from './cache';
import { envStr } from './env';
import { OperationInProgressError } from './errors';
import { runIdempotent } from './idempotency';
import { createLogger, type Logger } from './logger';
import {
  idempotencyKey,
  isForwardStep,
  stepPath,
  type Step,
  type StepRequestBody,
  type StepResponseBody,
} from './types';

/**
 * Raised when the CSV asked this step to fail on purpose.
 *
 * Deliberately maps to HTTP 500, NOT 4xx. A 4xx is classified as
 * non-retryable, so the step would fail on attempt 1 and never exercise
 * requirement 4's retry behaviour. A 500 makes the coordinator retry the full
 * three times and then compensate — which is the behaviour being demonstrated.
 */
export class InjectedFailureError extends Error {
  constructor(step: Step) {
    super(`Injected failure at ${step}`);
    this.name = 'InjectedFailureError';
  }
}

/** A business rule rejected the operation. Retrying cannot help — fail fast. */
export class BusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}

/**
 * Honour the CSV's fault injection.
 *
 * Forward steps check `failAt`. Compensations check `compFailAt`, unless
 * `force` is set — that flag comes only from the UI's manual Retry button, and
 * without it a NEEDS_ATTENTION order could never be cleared by a human because
 * the injected failure would fire forever.
 */
export function assertNoInjectedFailure(step: Step, body: StepRequestBody): void {
  if (isForwardStep(step)) {
    if (body.failAt === step) throw new InjectedFailureError(step);
    return;
  }
  if (body.compFailAt === step && !body.force) throw new InjectedFailureError(step);
}

function validateBody(raw: unknown): StepRequestBody {
  if (typeof raw !== 'object' || raw === null) throw new BusinessRuleError('body must be an object');
  const b = raw as Record<string, unknown>;
  if (typeof b['orderId'] !== 'string' || b['orderId'] === '') {
    throw new BusinessRuleError('orderId is required');
  }
  return {
    orderId: b['orderId'],
    sku: typeof b['sku'] === 'string' ? b['sku'] : '',
    qty: typeof b['qty'] === 'number' ? b['qty'] : 0,
    amount: typeof b['amount'] === 'string' ? b['amount'] : String(b['amount'] ?? '0'),
    failAt: typeof b['failAt'] === 'string' ? b['failAt'] : null,
    compFailAt: typeof b['compFailAt'] === 'string' ? b['compFailAt'] : null,
    force: b['force'] === true,
  };
}

export interface StepHandlerContext {
  /** The transaction the idempotency record is being written in. Use THIS, not the pool. */
  conn: PoolConnection;
  body: StepRequestBody;
  logger: Logger;
}

export type StepHandler = (ctx: StepHandlerContext) => Promise<Record<string, unknown>>;

/**
 * Wire one operation up as `POST /<kebab-step>`.
 *
 * All eight operations go through this — compensations included. It is
 * tempting to protect only the forward steps, but a refund retried after a
 * lost reply double-refunds exactly as badly as a double charge.
 */
export function registerStep(
  app: Express,
  opts: { pool: Pool; step: Step; logger: Logger; handler: StepHandler; cache?: Cache },
): void {
  const { pool, step, logger, handler, cache } = opts;

  app.post(stepPath(step), (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const body = validateBody(req.body);
        const log = logger.child({ orderId: body.orderId, step });

        assertNoInjectedFailure(step, body);

        const key = idempotencyKey(body.orderId, step);
        const { result, replayed } = await runIdempotent(
          pool,
          { key, operation: step, orderId: body.orderId },
          (conn) => handler({ conn, body, logger: log }),
          { ...(cache ? { cache } : {}) },
        );

        log.info(replayed ? 'step replayed from idempotency record' : 'step executed', { replayed });

        const payload: StepResponseBody = {
          ok: true,
          operation: step,
          orderId: body.orderId,
          replayed,
          data: result,
        };
        res.status(200).json(payload);
      } catch (err) {
        next(err);
      }
    })();
  });
}

/** Maps thrown errors onto the status codes errors.ts classifies as retry-or-not. */
function errorMiddleware(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof OperationInProgressError) {
      // Retryable: a twin request is mid-flight and will finish shortly.
      res.status(409).json({ ok: false, error: err.message, code: 'IN_PROGRESS' });
      return;
    }
    if (err instanceof BusinessRuleError) {
      // NOT retryable: an identical retry gets an identical rejection.
      res.status(422).json({ ok: false, error: err.message, code: 'BUSINESS_RULE' });
      return;
    }
    if (err instanceof InjectedFailureError) {
      // Retryable by design — see the class comment.
      logger.warn('injected failure', { error: err });
      res.status(500).json({ ok: false, error: err.message, code: 'INJECTED_FAILURE' });
      return;
    }
    logger.error('unhandled error', { error: err });
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'internal error',
      code: 'INTERNAL',
    });
  };
}

export interface ServiceApp {
  app: Express;
  logger: Logger;
  cache: Cache;
  /** Call after registering every step — error middleware must be registered last. */
  start(port: number): void;
}

export function createServiceApp(serviceName: string, pool: Pool): ServiceApp {
  const logger = createLogger(serviceName);
  const cache = createCache(envStr('REDIS_URL', 'redis://127.0.0.1:6379'), logger);
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    void (async () => {
      try {
        await pool.query('SELECT 1');
        // The cache is reported but is NOT part of the health verdict: a
        // service with Redis down is degraded, not unhealthy, and taking it
        // out of rotation for that would turn a slowdown into an outage.
        res.json({ ok: true, service: serviceName, cache: cache.isReady() });
      } catch (err) {
        res.status(503).json({ ok: false, service: serviceName, error: String(err) });
      }
    })();
  });

  return {
    app,
    logger,
    cache,
    start(port: number) {
      // Express matches middleware in registration order, so this has to come
      // after every route or thrown errors fall through to Express's default
      // HTML error page instead of our JSON contract.
      app.use(errorMiddleware(logger));
      app.listen(port, () => logger.info('service listening', { port }));
    },
  };
}
