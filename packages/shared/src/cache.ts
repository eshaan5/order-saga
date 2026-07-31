/**
 * Redis cache in front of the idempotency lookup.
 *
 * THE ONE RULE: this file can never change a correctness outcome. MySQL is the
 * authority. Every operation here degrades to a no-op on failure, so Redis
 * being empty, stale, or entirely down costs one extra database round trip and
 * nothing else. A cache that can cause a double charge is not a cache, it's a
 * second source of truth.
 *
 * WHY IT NEEDS NO INVALIDATION:
 * We only ever cache idempotency records in the COMPLETED state, and we only
 * write to Redis AFTER the MySQL transaction commits. A COMPLETED record is
 * immutable — nothing in the system updates or deletes one. (The only rows
 * ever mutated or removed are IN_PROGRESS ones, which are never cached.)
 *
 * So the cached data cannot go stale, because the underlying data cannot
 * change. That is a stronger guarantee than any invalidation strategy, and
 * it's the reason this cache is safe rather than merely fast.
 */

import { createClient } from 'redis';
import type { Logger } from './logger';

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
  /** For logging/health only — never branch correctness on this. */
  isReady(): boolean;
}

/** A cache that does nothing. Used when Redis isn't configured. */
export function createNullCache(): Cache {
  return {
    async get() {
      return null;
    },
    async set() {
      /* no-op */
    },
    async del() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
    isReady: () => false,
  };
}

export function createCache(url: string, logger: Logger): Cache {
  const client = createClient({
    url,
    socket: {
      // Keep retrying quietly in the background. A service must not fail to
      // start just because the cache isn't up yet.
      reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
    },
  });

  let ready = false;
  let loggedFailure = false;

  client.on('ready', () => {
    ready = true;
    loggedFailure = false;
    logger.info('cache connected');
  });

  client.on('error', (err: unknown) => {
    ready = false;
    // Log the first failure only — a down Redis with a reconnect loop would
    // otherwise produce hundreds of identical lines a minute.
    if (!loggedFailure) {
      loggedFailure = true;
      logger.warn('cache unavailable — continuing without it', { error: err });
    }
  });

  void client.connect().catch(() => {
    /* the 'error' handler above already reported it */
  });

  return {
    async get<T>(key: string): Promise<T | null> {
      if (!ready) return null;
      try {
        const raw = await client.get(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch {
        // A malformed entry or a dropped connection is a cache miss, never an
        // error the caller has to handle.
        return null;
      }
    },

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      if (!ready) return;
      try {
        await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
      } catch {
        /* best effort */
      }
    },

    async del(key: string): Promise<void> {
      if (!ready) return;
      try {
        await client.del(key);
      } catch {
        /* best effort */
      }
    },

    async close(): Promise<void> {
      try {
        // quit() in redis v4 — it drains pending commands before closing.
        // (close() is the v5 name.) disconnect() would drop them.
        if (client.isOpen) await client.quit();
      } catch {
        /* shutting down anyway */
      }
    },

    isReady: () => ready,
  };
}

/** Namespaced so the keyspace stays readable in redis-cli. */
export function idempotencyCacheKey(key: string): string {
  return `idem:${key}`;
}
