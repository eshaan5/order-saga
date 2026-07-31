/**
 * Retry + backoff. Pure functions, no database, no network — these run in
 * milliseconds and need nothing running.
 */

import { describe, expect, it, vi } from 'vitest';
import { HttpError, StepTimeoutError, backoffDelay, withRetry } from '@saga/shared';

/** Never actually wait — otherwise these tests would take seconds of real sleep. */
const noSleep = async (): Promise<void> => undefined;

describe('backoffDelay', () => {
  it('doubles each attempt and is capped at maxDelay', () => {
    // random() = 1 removes the jitter so the exponential curve is observable.
    const noJitter = () => 1;

    expect(backoffDelay(1, 100, 2000, noJitter)).toBe(100);
    expect(backoffDelay(2, 100, 2000, noJitter)).toBe(200);
    expect(backoffDelay(3, 100, 2000, noJitter)).toBe(400);
    expect(backoffDelay(4, 100, 2000, noJitter)).toBe(800);
    // 100 * 2^9 = 51200, capped to 2000
    expect(backoffDelay(10, 100, 2000, noJitter)).toBe(2000);
  });

  it('applies full jitter — every delay lands inside [0, exponential]', () => {
    // Without jitter, N callers that fail simultaneously all retry at the same
    // instant, re-hammering a service that is trying to recover. This asserts
    // the delay is actually spread rather than fixed.
    for (const r of [0, 0.25, 0.5, 0.99]) {
      const delay = backoffDelay(3, 100, 2000, () => r);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(400); // 100 * 2^2
    }
    expect(backoffDelay(3, 100, 2000, () => 0)).toBe(0);
  });
});

describe('withRetry', () => {
  const opts = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep: noSleep };

  it('calls once when the first attempt succeeds', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, opts)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and succeeds on a later attempt', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError(503, 'unavailable'))
      .mockResolvedValueOnce('ok');

    await expect(withRetry(fn, opts)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw new HttpError(500, 'boom');
    });
    await expect(withRetry(fn, opts)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-retryable error', async () => {
    // 422 means the request itself is wrong. Retrying it identically wastes
    // the budget and delays compensation, so it must stop after one attempt.
    const fn = vi.fn(async () => {
      throw new HttpError(422, 'insufficient stock');
    });
    await expect(withRetry(fn, opts)).rejects.toThrow('insufficient stock');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports every attempt, and distinguishes TIMEOUT from FAILED', async () => {
    // This callback is the seam the coordinator uses to write one
    // saga_step_attempts row per try — requirement 8's "and any retries".
    const seen: Array<{ attempt: number; outcome: string; willRetry: boolean }> = [];

    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new StepTimeoutError(3000))
      .mockRejectedValueOnce(new HttpError(500, 'boom'))
      .mockResolvedValueOnce('ok');

    await withRetry(fn, {
      ...opts,
      onAttempt: (info) =>
        void seen.push({
          attempt: info.attempt,
          outcome: info.outcome,
          willRetry: info.willRetry,
        }),
    });

    expect(seen).toEqual([
      { attempt: 1, outcome: 'TIMEOUT', willRetry: true },
      { attempt: 2, outcome: 'FAILED', willRetry: true },
      { attempt: 3, outcome: 'SUCCEEDED', willRetry: false },
    ]);
  });
});
