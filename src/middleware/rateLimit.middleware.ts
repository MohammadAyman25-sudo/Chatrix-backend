import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed per key within the window. */
  limit: number;
  /** Message returned on the 429 response. */
  message?: string;
  /**
   * When true, requests are keyed by the authenticated user id (falling back to
   * the client IP). Use for routes mounted after `requireAuth` so an account is
   * limited independently of the IP it connects from.
   */
  byUser?: boolean;
  /** Overrides the `RATE_LIMIT_ENABLED` env flag (mainly for tests). */
  enabled?: boolean;
}

function defaultKey(req: Request): string {
  // `ipKeyGenerator` normalizes IPv6 addresses into a shared subnet key.
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

/**
 * Builds an Express middleware that limits repeated requests. Responses use the
 * same `{ message }` shape as the rest of the API and return `429` with the
 * standard `RateLimit`/`Retry-After` headers (draft-7).
 */
export function createRateLimiter(options: RateLimitOptions) {
  const {
    windowMs,
    limit,
    message = 'Too many requests, please slow down.',
    byUser = false,
  } = options;
  const enabled = options.enabled ?? env.RATE_LIMIT_ENABLED;

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !enabled,
    keyGenerator: (req: Request) => {
      if (byUser && req.user?.id) {
        return `user:${req.user.id}`;
      }
      return defaultKey(req);
    },
    handler: (_req, res) => {
      res.status(429).json({ message });
    },
  });
}

const MINUTE = 60 * 1000;

/** Broad safety net applied to every API route, keyed by client IP. */
export const globalLimiter = createRateLimiter({
  windowMs: 15 * MINUTE,
  limit: 600,
});

/** Brute-force protection for credential endpoints (`/auth/login`, `/register`). */
export const authLimiter = createRateLimiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  message: 'Too many authentication attempts, please try again later.',
});

/**
 * Token refresh happens opportunistically (e.g. on any 401), so it needs a
 * higher ceiling than login but is still bounded.
 */
export const refreshLimiter = createRateLimiter({
  windowMs: 15 * MINUTE,
  limit: 60,
});

/** Prevents user-enumeration scraping through the search endpoint. */
export const searchLimiter = createRateLimiter({
  windowMs: MINUTE,
  limit: 30,
  byUser: true,
  message: 'Too many searches, please slow down.',
});

/** Bounds message spam over both REST and socket paths. */
export const messageSendLimiter = createRateLimiter({
  windowMs: MINUTE,
  limit: 60,
  byUser: true,
  message: 'You are sending messages too quickly.',
});

/** Bounds image/avatar uploads. */
export const uploadLimiter = createRateLimiter({
  windowMs: 15 * MINUTE,
  limit: 30,
  byUser: true,
  message: 'Too many uploads, please try again later.',
});

/** Bounds message-attachment uploads (one per voice note / media message). */
export const attachmentLimiter = createRateLimiter({
  windowMs: MINUTE,
  limit: 60,
  byUser: true,
  message: 'You are uploading files too quickly.',
});
