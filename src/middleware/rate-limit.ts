import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request } from 'express';

import { RATE_LIMITS } from '../config/constants.js';
import { sendError } from '../lib/api-response.js';

interface LimiterOptions {
  windowMs: number;
  limit: number;
  /** How the window is bucketed. Defaults to per-IP; external limiters bucket per user instead. */
  keyGenerator?: (req: Request) => string;
}

export function limiter({ windowMs, limit, keyGenerator }: LimiterOptions): RateLimitRequestHandler {
  const retryAfter = Math.ceil(windowMs / 1000);

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator === undefined ? {} : { keyGenerator }),
    handler: (_req, res) => {
      sendError(res, 'RATE_LIMITED', 'Too many requests. Please try again shortly.', {
        retryAfter,
      });
    },
  });
}

/**
 * Global per-IP limiter (R-B10). Stricter limiters for AI and external-backed endpoints are
 * added by the phases that introduce those routes.
 */
export const globalRateLimiter = limiter(RATE_LIMITS.global);

/** Credential endpoints get a much tighter budget to slow brute-force attempts (R-B10). */
export const authRateLimiter = limiter(RATE_LIMITS.auth);

/**
 * External-backed endpoints (crypto, currency). Mounted after `requireAuth`, so the window is
 * keyed by the authenticated user — one account cannot spend a shared upstream budget for the
 * rest (R-B10). The `userId` is always present by the time this runs; the fallback only guards
 * against a mis-wired route.
 */
export const externalApiRateLimiter = limiter({
  ...RATE_LIMITS.external,
  keyGenerator: (req) => req.userId ?? 'unauthenticated',
});
