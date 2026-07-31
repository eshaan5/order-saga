/**
 * Structured JSON logging — one object per line.
 *
 * Requirement 8 wants "a clear record ... so anyone can follow a single order
 * from start to finish". Line-delimited JSON makes that a one-liner:
 *
 *   docker compose logs | grep ORD000034 | jq .
 *
 * which you cannot do with free-form `console.log("charging order " + id)`.
 *
 * The durable audit trail lives in MySQL (saga_steps, saga_step_attempts).
 * These logs are the live view of the same events.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  /** Returns a logger that stamps extra fields onto every line. */
  child(ctx: Record<string, unknown>): Logger;
}

/** Errors don't survive JSON.stringify — pull the useful parts out by hand. */
function serialiseValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause !== undefined ? { cause: String(value.cause) } : {}),
    };
  }
  return value;
}

export function createLogger(
  service: string,
  baseCtx: Record<string, unknown> = {},
): Logger {
  const threshold =
    LEVEL_RANK[(process.env['LOG_LEVEL'] as LogLevel) ?? 'info'] ?? LEVEL_RANK.info;

  function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < threshold) return;

    const merged: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...baseCtx,
      ...ctx,
    };

    for (const [k, v] of Object.entries(merged)) merged[k] = serialiseValue(v);

    const line = JSON.stringify(merged) + '\n';
    if (level === 'error' || level === 'warn') process.stderr.write(line);
    else process.stdout.write(line);
  }

  return {
    debug: (msg, ctx) => write('debug', msg, ctx),
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
    child: (ctx) => createLogger(service, { ...baseCtx, ...ctx }),
  };
}
