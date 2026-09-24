import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { __resetCoinGeckoCaches } from '../src/integrations/coingecko.client.js';

/**
 * Crypto suite (Phase 9, R-T4). CoinGecko is the only external dependency and is ALWAYS mocked
 * here — the free tier is metered, so CI never touches it. `fetch` is stubbed per test and the
 * integration's caches are reset between tests so a frozen clock cannot leak across them (R-T6).
 * The clock is frozen so cache TTLs can be advanced deterministically. Prisma is mocked to an
 * empty object: nothing in `/crypto` reads the database, it is public market data.
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
const BASE = '/api/v1/crypto';
const OWNER = 'usr_owner';

/** Frozen so cache windows can be advanced by hand; only `Date` is faked (R-T6). */
const NOW = '2026-09-24T12:00:00.000Z';
const AFTER_FRESH = '2026-09-24T12:02:00.000Z'; // +2 min: past every fresh window, well inside stale.

/** One top-markets coin carries every figure; the second omits them, exercising the null mapping. */
const TOP_MARKETS_RAW = [
  {
    id: 'bitcoin',
    symbol: 'btc',
    name: 'Bitcoin',
    current_price: 65_000,
    price_change_percentage_24h: 2.5,
    market_cap: 1_280_000_000_000,
    market_cap_rank: 1,
  },
  { id: 'newcoin', symbol: 'new', name: 'New Coin', market_cap: null },
];

const SEARCH_RAW = {
  coins: [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1 },
    { id: 'bitcoin-cash', symbol: 'bch', name: 'Bitcoin Cash', market_cap_rank: 20 },
  ],
};

const IDS_MARKETS_RAW = [
  {
    id: 'bitcoin',
    symbol: 'btc',
    name: 'Bitcoin',
    current_price: 65_000,
    price_change_percentage_24h: 2.5,
    market_cap: 1_280_000_000_000,
    market_cap_rank: 1,
  },
];

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

    if (url.includes('/search?')) {
      return Promise.resolve(jsonResponse(SEARCH_RAW));
    }

    if (url.includes('/coins/markets') && url.includes('ids=')) {
      return Promise.resolve(jsonResponse(IDS_MARKETS_RAW));
    }

    if (url.includes('/coins/markets')) {
      return Promise.resolve(jsonResponse(TOP_MARKETS_RAW));
    }

    return Promise.resolve(jsonResponse({ error: 'unexpected' }, 404));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  __resetCoinGeckoCaches();
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
  it('rejects an unauthenticated markets request with 401', async () => {
    const response = await request(app).get(`${BASE}/markets`);

    expect(response.status).toBe(401);
    expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive page with 400 before reaching the upstream', async () => {
    const response = await request(app)
      .get(`${BASE}/markets?page=0`)
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a search with a missing term with 400', async () => {
    const response = await request(app).get(`${BASE}/search`).set('Cookie', session(OWNER));

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a search with a blank term with 400', async () => {
    const response = await request(app).get(`${BASE}/search?q=%20`).set('Cookie', session(OWNER));

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('markets and search shape', () => {
  it('returns the top markets, mapping omitted upstream figures to null', async () => {
    const response = await request(app).get(`${BASE}/markets`).set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
    const { coins } = (response.body as SuccessBody<{ coins: unknown[] }>).data;

    expect(coins).toEqual([
      {
        id: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        price: 65_000,
        change24h: 2.5,
        marketCap: 1_280_000_000_000,
        rank: 1,
      },
      {
        id: 'newcoin',
        symbol: 'new',
        name: 'New Coin',
        price: null,
        change24h: null,
        marketCap: null,
        rank: null,
      },
    ]);
  });

  it('resolves a market search to priced coins via search then markets-by-ids', async () => {
    const response = await request(app)
      .get(`${BASE}/markets?search=bit`)
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
    const { coins } = (response.body as SuccessBody<{ coins: Array<{ price: number | null }> }>).data;

    expect(coins).toHaveLength(1);
    expect(coins[0]?.price).toBe(65_000);
    // Two upstream calls: the search, then the markets lookup for the resolved ids.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list without a markets call when nothing matches', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ coins: [] })));

    const response = await request(app)
      .get(`${BASE}/markets?search=zzz`)
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
    expect((response.body as SuccessBody<{ coins: unknown[] }>).data.coins).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns lightweight, price-free hits from the search endpoint', async () => {
    const response = await request(app)
      .get(`${BASE}/search?q=bit`)
      .set('Cookie', session(OWNER));

    expect(response.status).toBe(200);
    const { coins } = (response.body as SuccessBody<{ coins: unknown[] }>).data;

    expect(coins).toEqual([
      { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', rank: 1 },
      { id: 'bitcoin-cash', symbol: 'bch', name: 'Bitcoin Cash', rank: 20 },
    ]);
  });
});

describe('upstream failure and degradation', () => {
  it('maps a 429 rate-limit to a 503 UPSTREAM_UNAVAILABLE with no cache to fall back on', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'rate limited' }, 429)));

    const response = await request(app).get(`${BASE}/markets`).set('Cookie', session(OWNER));

    expect(response.status).toBe(503);
    expect((response.body as ErrorBody).error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('maps a 5xx to a 503 UPSTREAM_UNAVAILABLE', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'boom' }, 502)));

    const response = await request(app).get(`${BASE}/markets`).set('Cookie', session(OWNER));

    expect(response.status).toBe(503);
    expect((response.body as ErrorBody).error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('serves stale data when a later refresh fails within the stale window', async () => {
    const first = await request(app).get(`${BASE}/markets`).set('Cookie', session(OWNER));
    expect(first.status).toBe(200);

    // Past the fresh window so a refetch is attempted, but well inside the 24h stale window.
    vi.setSystemTime(new Date(AFTER_FRESH));
    fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));

    const second = await request(app).get(`${BASE}/markets`).set('Cookie', session(OWNER));

    expect(second.status).toBe(200);
    expect((second.body as SuccessBody<{ coins: unknown[] }>).data.coins).toEqual(
      (first.body as SuccessBody<{ coins: unknown[] }>).data.coins,
    );
  });
});

describe('cache TTL', () => {
  it('serves repeat requests from cache within the fresh window, then refetches after it', async () => {
    await request(app).get(`${BASE}/markets`).set('Cookie', session(OWNER));
    await request(app).get(`${BASE}/markets`).set('Cookie', session(OWNER));

    // Both within the fresh window: only the first reached the upstream (R-E6 burst guard).
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(AFTER_FRESH));
    await request(app).get(`${BASE}/markets`).set('Cookie', session(OWNER));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});




