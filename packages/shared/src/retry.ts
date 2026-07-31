/**
 * Retry with exponential backoff and full jitter.
 *
 * Requirement 4: "if a step fails, try it a few more times (with a short wait
 * between tries) before giving up."
 */

import { isRetryableError } from './errors';
import { StepTimeoutError } from './errors';
import type { AttemptOutcome } from './types';

export interface AttemptInfo {
  attempt: number;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  outcome: AttemptOutcome;
  error?: unknown;
  /** False on the final attempt, or when the error isn't worth retrying. */
  willRetry: boolean;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable?: (err: unknown) => boolean;
  /**
   * Called once per attempt, success or failure. This is the seam the
   * coordinator uses to write a saga_step_attempts row per try, which is what
   * makes requirement 8's "any retries" auditable rather than just a counter.
   */
  onAttempt?: (info: AttemptInfo) => void | Promise<void>;
  /** Injectable for tests — lets a test run instantly instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests — makes jittered delays deterministic. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full jitter:  delay = random(0, min(maxDelay, base * 2^(attempt-1)))
 *
 * The exponential part is obvious — back off harder each time. The jitter is
 * the part people leave out and shouldn't.
 *
 * Picture 200 orders hitting the payment service concurrently when it
 * hiccups. All 200 fail at roughly the same instant. WITHOUT jitter all 200
 * retry at exactly t+100ms, then all at t+200ms — a synchronised sledgehammer
 * that keeps re-killing a service trying to recover ("thundering herd").
 * Randomising each delay spreads that wave across the window instead.
 *
 * Full jitter (random across the whole range, not just the top half) gives the
 * widest spread and is what AWS recommends for exactly this case.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    isRetryable = isRetryableError,
    onAttempt,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = new Date();
    try {
      const result = await fn(attempt);
      const finishedAt = new Date();
      await onAttempt?.({
        attempt,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        outcome: 'SUCCEEDED',
        willRetry: false,
      });
      return result;
    } catch (err) {
      const finishedAt = new Date();
      lastError = err;

      // Distinguish a timeout from an ordinary failure so the audit trail can
      // show "step timed out" rather than a generic error.
      const outcome: AttemptOutcome =
        err instanceof StepTimeoutError ||
        (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
          ? 'TIMEOUT'
          : 'FAILED';

      const willRetry = attempt < maxAttempts && isRetryable(err);

      await onAttempt?.({
        attempt,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        outcome,
        error: err,
        willRetry,
      });

      if (!willRetry) throw err;

      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, random));
    }
  }

  // Unreachable in practice: the loop either returns or throws.
  throw lastError;
}
