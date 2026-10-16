/**
 * Minimal in-memory fixed-window rate limiter used for Socket.IO events, where
 * `express-rate-limit` (an HTTP middleware) does not apply. State is per-process;
 * a multi-instance deployment would need a shared store, but a single instance
 * is enough to stop per-user message spam.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Opportunistic cleanup so long-lived processes do not leak keys forever. */
const MAX_BUCKETS = 10_000;

function prune(now: number): void {
  if (buckets.size < MAX_BUCKETS) {
    return;
  }
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

/**
 * Records one event for `key` and returns `true` while it is within `limit`
 * events per `windowMs`. Returns `false` when the caller should be throttled.
 */
export function consume(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    prune(now);
    return true;
  }
  if (bucket.count >= limit) {
    return false;
  }
  bucket.count += 1;
  return true;
}

/** Clears all counters (test helper). */
export function resetRateLimiter(): void {
  buckets.clear();
}
