import rateLimit from 'express-rate-limit';

import { RATE_LIMITS } from '../config/constants.js';
import { sendError } from '../lib/api-response.js';

function limiter({ windowMs, limit }: { windowMs: number; limit: number }) {
  const retryAfter = Math.ceil(windowMs / 1000);

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
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
