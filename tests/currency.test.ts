import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_COOKIES } from '../src/config/constants.js';
import { __resetFrankfurterCaches } from '../src/integrations/frankfurter.client.js';
import { signAccessToken } from '../src/lib/jwt.js';

import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * Currency suite (Phase 8, R-T4). Frankfurter is the only external dependency and is ALWAYS mocked
 * here — CI never touches the live API. `fetch` is stubbed per test and the integration's caches
 * are reset between tests so a frozen clock cannot leak across them (R-T6). The clock is frozen so
 * the 6h/24h cache windows can be advanced deterministically. Prisma is mocked to an empty object:
 * nothing in `/currency` reads the database, it is public reference data.
 */

vi.mock('../src/middleware/rate-limit.js', () => ({
  globalRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  authRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  externalApiRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {},
  disconnectPrisma: () => Promise.resolve(),
}));

const app = createApp();
const BASE = '/api/v1/currency';
const OWNER = 'usr_owner';

/** Frozen so cache windows can be advanced by hand; only `Date` is faked (R-T6). */
const NOW = '2026-09-24T12:00:00.000Z';
const AFTER_FRESH = '2026-09-24T19:00:00.000Z'; // +7h: past the 6h fresh window, well inside 24h stale.

/** The supported currencies as Frankfurter's code→name map. */
const CURRENCIES_RAW = {
  USD: 'United States Dollar',
  EUR: 'Euro',
  GBP: 'British Pound Sterling',
  JPY: 'Japanese Yen',
};

/** One working day's rates; Frankfurter never echoes the base inside `rates`, and neither do we. */
const RATES_RAW = {
  amount: 1,
  base: 'USD',
  date: '2026-09-23',
  rates: { EUR: 0.9, GBP: 0.75, JPY: 150 },
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Minimal `Response` stand-in: the integration only reads `ok`, `status`, and `json()`. */
function jsonResponse(body: unknown, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** The happy-path upstream: branches on the URL the integration builds for each endpoint. */
function stubUpstreamOk(): void {
  fetchMock.mockImplementation((input: string | URL) => {
    const url = String(input);

    if (url.includes('/currencies')) {
      return Promise.resolve(jsonResponse(CURRENCIES_RAW));
    }

    if (url.includes('/latest')) {
      return Promise.resolve(jsonResponse(RATES_RAW));
    }

    return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  __resetFrankfurterCaches();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  stubUpstreamOk();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function session(userId: string): string {
  return `${AUTH_COOKIES.access.name}=${signAccessToken(userId)}`;
}

describe('auth and validation', () => {
  it('rejects an unauthenticated rates request with 401', async () => {
    const response = await request(app).get(`${BASE}/rates`);

    expect(response.status).toBe(401);
    expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed base code with 400 before reaching the upstream', async () => {
    const response = await request(app).get(`${BASE}/rates?base=US`).set('Cookie', session(OWNER));

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a convert with a non-positive amount with 400 before the upstream', async () => {
    const response = await request(app)
      .get(`${BASE}/convert?from=USD&to=EUR&amount=0`)
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a well-formed but unsupported code with 400, without a rates call', async () => {
    const response = await request(app)
      .get(`${BASE}/convert?from=USD&to=ZZZ&amount=10`)
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    // The currency list was consulted; no rates lookup happened for the bad code.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/currencies');
  });
});

describe('rates and convert shape', () => {
  it('returns the day rates with an asOf date for the default USD base', async () => {
    const response = await request(app).get(`${BASE}/rates`).set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
    const data = (response.body as SuccessBody<{ base: string; asOf: string; rates: unknown }>)
      .data;

    expect(data.base).toBe('USD');
    expect(data.asOf).toBe('2026-09-23');
    expect(data.rates).toEqual({ EUR: 0.9, GBP: 0.75, JPY: 150 });
  });

  it('converts an amount server-side using the upstream rate', async () => {
    const response = await request(app)
      .get(`${BASE}/convert?from=USD&to=EUR&amount=100`)
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
    const data = (response.body as SuccessBody<{ result: number; rate: number; date: string }>)
      .data;

    expect(data).toEqual({ result: 90, rate: 0.9, date: '2026-09-23' });
  });

  it('treats a same-currency conversion as a rate of 1', async () => {
    const response = await request(app)
      .get(`${BASE}/convert?from=USD&to=USD&amount=42.5`)
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
    const data = (response.body as SuccessBody<{ result: number; rate: number; date: string }>)
      .data;

    expect(data).toEqual({ result: 42.5, rate: 1, date: '2026-09-23' });
  });
});

describe('upstream failure and degradation', () => {
  it('maps a 429 rate-limit to a 503 UPSTREAM_UNAVAILABLE with no cache to fall back on', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'rate limited' }, 429)));

    const response = await request(app).get(`${BASE}/rates`).set('Cookie', session(OWNER));

    expect(response.status).toBe(503);
    expect((response.body as ErrorBody).error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('maps a 5xx to a 503 UPSTREAM_UNAVAILABLE', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'boom' }, 502)));

    const response = await request(app).get(`${BASE}/rates`).set('Cookie', session(OWNER));

    expect(response.status).toBe(503);
    expect((response.body as ErrorBody).error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('serves stale rates when a later refresh fails within the stale window', async () => {
    const first = await request(app).get(`${BASE}/rates`).set('Cookie', session(OWNER));
    expect(first.status).toBe(200);

    // Past the 6h fresh window so a refetch is attempted, but well inside the 24h stale window.
    vi.setSystemTime(new Date(AFTER_FRESH));
    fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));

    const second = await request(app).get(`${BASE}/rates`).set('Cookie', session(OWNER));

    expect(second.status).toBe(200);
    expect((second.body as SuccessBody<unknown>).data).toEqual(
      (first.body as SuccessBody<unknown>).data,
    );
  });
});

describe('cache TTL', () => {
  it('serves repeat rates from cache within the fresh window, then refetches after it', async () => {
    await request(app).get(`${BASE}/rates`).set('Cookie', session(OWNER));
    await request(app).get(`${BASE}/rates`).set('Cookie', session(OWNER));

    // First request: one currencies call + one rates call. Second is fully cached (R-E6 burst guard).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date(AFTER_FRESH));
    await request(app).get(`${BASE}/rates`).set('Cookie', session(OWNER));

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

