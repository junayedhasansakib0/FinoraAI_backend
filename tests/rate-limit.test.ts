import express, { type Express, type Request } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { ErrorBody } from '../src/lib/api-response.js';
import { limiter } from '../src/middleware/rate-limit.js';

/**
 * Rate-limit middleware suite (R-B10). The per-module suites stub the limiters out so their own
 * assertions stay deterministic, so the limiter's own behaviour — the 429, the shared error
 * envelope, the `retryAfter`, and the per-user bucketing the external limiter relies on — is
 * proven here instead. Each test builds a throwaway app around a fresh `limiter()` with a tiny
 * budget, so exceeding it is a matter of counting requests, not of waiting or of hammering the
 * real 20-/300-per-window limits (R-T6). No network, no database, no clock.
 */

/** A limiter that trips on the third request, mounted on a route that otherwise always 200s. */
function appWithLimit(limit: number): Express {
  const app = express();
  app.use(limiter({ windowMs: 15 * 60 * 1000, limit }));
  app.get('/', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

/** Mirrors the external limiter: keyed by an authenticated id read off the request. */
function appKeyedByUser(limit: number): Express {
  const app = express();
  app.use((req: Request, _res, next) => {
    const header = req.get('x-user');
    req.userId = header === undefined ? 'unauthenticated' : header;
    next();
  });
  app.use(limiter({ windowMs: 60 * 1000, limit, keyGenerator: (req) => req.userId ?? 'anon' }));
  app.get('/', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('rate limiter', () => {
  it('lets requests through up to the limit, then answers 429', async () => {
    const app = appWithLimit(2);

    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(429);
  });

  it('answers 429 with the shared RATE_LIMITED envelope and a retryAfter (R-B9/R-B10)', async () => {
    const app = appWithLimit(1);

    await request(app).get('/');
    const response = await request(app).get('/');
    const body = response.body as ErrorBody;

    expect(response.status).toBe(429);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMITED');
    // windowMs is 15 minutes; retryAfter is that window expressed in whole seconds.
    expect(body.error.details).toEqual({ retryAfter: 15 * 60 });
  });

  it('advertises the standard RateLimit headers and drops the legacy ones', async () => {
    const app = appWithLimit(5);

    const response = await request(app).get('/');

    expect(response.headers).toHaveProperty('ratelimit-limit');
    expect(response.headers).not.toHaveProperty('x-ratelimit-limit');
  });

  it('buckets per user, so one account cannot spend another’s budget (R-B10)', async () => {
    const app = appKeyedByUser(1);

    // One account exhausts its own single-request budget.
    expect((await request(app).get('/').set('x-user', 'usr_a')).status).toBe(200);
    expect((await request(app).get('/').set('x-user', 'usr_a')).status).toBe(429);

    // A different account is untouched by the first one's spending.
    expect((await request(app).get('/').set('x-user', 'usr_b')).status).toBe(200);
  });
});
