import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody } from '../src/lib/api-response.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { resetStore, seedUser } from './helpers/db-double.js';

/**
 * Verified-email access gate (ARCHITECTURE.md §7, R-A7/R-T3). Proves the policy is enforced on the
 * server, not by hiding buttons: a direct API call (exactly what Supertest makes) from an unverified
 * account is refused on every AI endpoint and on the Analytics endpoint, while the basic account
 * surfaces stay open. The gate reads the flag per request, so verifying mid-session unlocks at once.
 */

vi.mock('../src/middleware/rate-limit.js', () => ({
  globalRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  authRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  resendVerificationRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  externalApiRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../src/lib/prisma.js', async () => {
  const { prismaDouble } = await import('./helpers/db-double.js');

  return { prisma: prismaDouble, disconnectPrisma: () => Promise.resolve() };
});

const app = createApp();
const OWNER = 'usr_owner';

beforeEach(() => {
  resetStore();
});

function session(userId: string): string {
  return `${AUTH_COOKIES.access.name}=${signAccessToken(userId)}`;
}

/** Every AI endpoint plus the Analytics endpoint — the full gated surface (audited against §7). */
const GATED = [
  ['post', '/api/v1/ai/spending-analysis'],
  ['post', '/api/v1/ai/monthly-summary'],
  ['post', '/api/v1/ai/savings-recommendations'],
  ['post', '/api/v1/ai/budget-recommendations'],
  ['post', '/api/v1/ai/chat'],
  ['get', '/api/v1/ai/reports'],
  ['get', '/api/v1/dashboard/analytics'],
] as const;

function call(method: 'get' | 'post', path: string, userId: string) {
  const base = method === 'get' ? request(app).get(path) : request(app).post(path).send({});
  return base.set('Cookie', session(userId));
}

describe('verified-email gate — unverified account', () => {
  beforeEach(() => {
    seedUser({ id: OWNER, emailVerified: false });
  });

  it.each(GATED)('refuses %s %s with 403 EMAIL_VERIFICATION_REQUIRED', async (method, path) => {
    const response = await call(method, path, OWNER);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    // The message is safe and constant — it never reveals account state beyond "verify to proceed".
    expect(body.error.message).toMatch(/verify your email/i);
  });

  it('still serves the basic dashboard summary (soft gate keeps account viewing open)', async () => {
    const response = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
  });
});

describe('verified-email gate — access control ordering', () => {
  it('answers 401 before the gate when there is no session', async () => {
    const response = await request(app).get('/api/v1/dashboard/analytics');

    expect(response.status).toBe(401);
  });

  it('lets a verified account through the gate', async () => {
    seedUser({ id: OWNER, emailVerified: true });

    const response = await request(app)
      .get('/api/v1/ai/reports')
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
  });

  it('unlocks the moment the account is verified, with no new session', async () => {
    const user = seedUser({ id: OWNER, emailVerified: false });

    const locked = await request(app).get('/api/v1/ai/reports').set('Cookie', session(OWNER));
    expect(locked.status).toBe(403);

    // Same cookie, same request — only the stored flag changes, as verify-email would set it.
    user.emailVerified = true;

    const unlocked = await request(app).get('/api/v1/ai/reports').set('Cookie', session(OWNER));
    expect(unlocked.status).toBe(200);
  });
});
