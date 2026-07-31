/**
 * Retry classification.
 *
 * This matters in both directions: retrying a genuinely broken request wastes
 * the budget and delays compensation, while NOT retrying a transient blip
 * cancels an order that would have succeeded a moment later.
 */

import { describe, expect, it } from 'vitest';
import {
  HttpError,
  OperationInProgressError,
  StepTimeoutError,
  isRetryableError,
} from '@saga/shared';

describe('isRetryableError', () => {
  it('retries 5xx — the server broke, it may not break again', () => {
    expect(isRetryableError(new HttpError(500, 'x'))).toBe(true);
    expect(isRetryableError(new HttpError(503, 'x'))).toBe(true);
  });

  it('retries 429 and 409', () => {
    // 429 is explicitly "slow down and try again".
    expect(isRetryableError(new HttpError(429, 'x'))).toBe(true);
    // 409 is our own idempotency IN_PROGRESS marker: a twin request is
    // mid-flight and will shortly have a stored result to replay.
    expect(isRetryableError(new HttpError(409, 'x'))).toBe(true);
    expect(isRetryableError(new OperationInProgressError('k'))).toBe(true);
  });

  it('does NOT retry other 4xx', () => {
    // An identical retry gets an identical rejection.
    expect(isRetryableError(new HttpError(400, 'x'))).toBe(false);
    expect(isRetryableError(new HttpError(404, 'x'))).toBe(false);
    expect(isRetryableError(new HttpError(422, 'insufficient stock'))).toBe(false);
  });

  it('retries timeouts', () => {
    expect(isRetryableError(new StepTimeoutError(3000))).toBe(true);

    // AbortSignal.timeout() rejects with a DOMException named TimeoutError.
    const aborted = new Error('aborted');
    aborted.name = 'TimeoutError';
    expect(isRetryableError(aborted)).toBe(true);
  });

  it('retries transient network failures', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it("unwraps fetch's cause — this is the one that bites in production", () => {
    // Node's fetch does not surface network errors directly. It throws
    // `TypeError: fetch failed` and hides the real error on .cause. Classify
    // only the outer error and every connection refusal looks non-retryable,
    // so a service restarting would cancel orders instead of being retried.
    const wrapped = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(isRetryableError(wrapped)).toBe(true);
  });

  it('does not retry unknown errors', () => {
    expect(isRetryableError(new Error('something odd'))).toBe(false);
    expect(isRetryableError('a string')).toBe(false);
  });
});
