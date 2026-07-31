/**
 * The coordinator's outbound call to a service: one step, with a hard time
 * limit, retries, and a deterministic idempotency key.
 *
 * Uses Node 22's built-in fetch — no axios/undici dependency needed.
 */

import { HttpError, StepTimeoutError } from './errors';
import { withRetry, type AttemptInfo } from './retry';
import { idempotencyKey, stepPath, type Step, type StepRequestBody, type StepResponseBody } from './types';

export interface CallStepOptions {
  /** e.g. http://127.0.0.1:3003 */
  baseUrl: string;
  step: Step;
  body: StepRequestBody;
  /** Requirement 4's per-step time limit. Applies to EACH attempt. */
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onAttempt?: (info: AttemptInfo) => void | Promise<void>;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function callStep(options: CallStepOptions): Promise<StepResponseBody> {
  const { baseUrl, step, body, timeoutMs, maxAttempts, baseDelayMs, maxDelayMs, onAttempt } = options;

  const url = `${baseUrl.replace(/\/$/, '')}${stepPath(step)}`;
  // Derived from orderId + step, so every retry sends the SAME key. This is
  // what lets a service recognise "I already did this" after a lost reply.
  const key = idempotencyKey(body.orderId, step);

  return withRetry<StepResponseBody>(
    async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify(body),
          // The time limit. Note it bounds each ATTEMPT, not the whole retry
          // sequence — so worst case wall time is roughly
          // maxAttempts * timeoutMs + the backoff delays.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
        // Translate it into our own type so callers don't have to know that.
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new StepTimeoutError(timeoutMs);
        }
        throw err; // network errors pass through; errors.ts classifies them
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new HttpError(
          response.status,
          `${step} -> HTTP ${response.status}`,
          parseMaybeJson(text),
        );
      }

      return (await response.json()) as StepResponseBody;
    },
    { maxAttempts, baseDelayMs, maxDelayMs, ...(onAttempt ? { onAttempt } : {}) },
  );
}
