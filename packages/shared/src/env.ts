/**
 * Typed environment variable reading.
 *
 * The point is to fail loudly at startup rather than mysteriously at runtime.
 * A missing DB_HOST should crash the process on line 1 with a clear message,
 * not surface forty minutes into a bulk run as "connect ECONNREFUSED".
 */

export function envStr(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw !== undefined && raw !== '') return raw;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

export function envInt(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

export function envBool(name: string, fallback?: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}
