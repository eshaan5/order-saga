/**
 * Error types + the retry classification.
 *
 * Deciding what's worth retrying matters in both directions: retrying a
 * genuinely broken request wastes the retry budget and delays compensation,
 * while NOT retrying a transient blip cancels an order that would have
 * succeeded a moment later.
 */

/** A non-2xx response from a service. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** A step exceeded its per-attempt time limit (requirement 4). */
export class StepTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Step timed out after ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Thrown by a service when the same idempotency key is already mid-flight in
 * another instance. Surfaces as HTTP 409 and IS retryable — the twin request
 * will finish shortly and the retry will replay its stored result.
 */
export class OperationInProgressError extends Error {
  constructor(readonly key: string) {
    super(`Operation already in progress for key ${key}`);
    this.name = 'OperationInProgressError';
  }
}

/**
 * Transient network failures. Node's fetch wraps these in a
 * `TypeError: fetch failed` and hides the real error on `.cause`, so we have
 * to unwrap before we can classify.
 */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED', // service is down or still booting
  'ECONNRESET', // connection dropped mid-flight
  'ETIMEDOUT', // TCP-level timeout
  'EPIPE', // wrote to a closed socket
  'EAI_AGAIN', // transient DNS failure
  'UND_ERR_SOCKET', // undici socket error
  'UND_ERR_CONNECT_TIMEOUT',
]);

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof StepTimeoutError) return true;
  if (err instanceof OperationInProgressError) return true;

  if (err instanceof HttpError) {
    // 5xx — the server broke, it may well not break next time.
    if (err.status >= 500) return true;
    // 429 — explicitly "slow down and try again".
    if (err.status === 429) return true;
    // 409 — our own idempotency IN_PROGRESS marker.
    if (err.status === 409) return true;
    // Any other 4xx means the request itself is wrong. An identical retry
    // gets an identical rejection, so give up now and start compensating.
    return false;
  }

  // AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'.
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return true;
  }

  const code = errorCode(err);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;

  // fetch hides the real network error one level down.
  if (err instanceof Error && err.cause !== undefined) {
    const causeCode = errorCode(err.cause);
    if (causeCode && RETRYABLE_NETWORK_CODES.has(causeCode)) return true;
  }

  return false;
}
