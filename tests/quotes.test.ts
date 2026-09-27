import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { QUOTE_DISCLAIMER, type QuoteResult } from '../src/modules/quotes/quotes.constants.js';
import { resetStore, seedUser } from './helpers/db-double.js';

/**
 * `GET /quotes/:category` suite (ARCHITECTURE.md §7, §9; R-T3/R-T4/R-T6). The provider is the
 * in-memory mock (NODE_ENV=test defaults the AI Service to it, R-T4); the clock is frozen (R-T6) so
 * cache windows are deterministic. These prove the quote rules: the endpoint is `requireAuth`-only
 * (an unverified account succeeds — it is NOT behind the `/ai` verified gate), a valid category
 * returns the `{ quote, category, source, disclaimer }` envelope, an invalid one is the only error
 * (400), the global cache serves a generated line to the next caller with one provider call, the
 * in-flight guard collapses concurrent misses into one generation, and — the point of the feature —
 * every generation failure mode (provider down, malformed, too-long, off-category) is swallowed into
 * a 200 `source:'fallback'` so the page can never break (§9).
 */

vi.mock('../src/middleware/rate-limit.js', () => ({
  globalRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  authRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  resendVerificationRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  externalApiRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

vi.mock('../src/lib/prisma.js', async () => {
  const { prismaDouble } = await import('./helpers/db-double.js');

  return { prisma: prismaDouble, disconnectPrisma: () => Promise.resolve() };
});

const app = createApp();
const BASE = '/api/v1/quotes';
const OWNER = 'usr_owner';
const NOW = '2026-09-15T12:00:00.000Z';

// PLACEHOLDER_REST

/** A well-formed generated line for the goals section, matching quoteOutputSchema (R-I4). */
const GOALS_QUOTE_TEXT = 'Small steady steps toward your goal add up far faster than you expect.';
const GOALS_QUOTE = JSON.stringify({ quote: GOALS_QUOTE_TEXT, category: 'goals' });

// The mock provider and the AI quota live in the modules the AI Service imports, so we drive them
// directly; the quote service exposes its own reset + settle hooks for deterministic cache tests.
async function mock() {
  return import('../src/ai/mock.provider.js');
}

async function quota() {
  return import('../src/ai/ai.service.js');
}

async function quotes() {
  return import('../src/modules/quotes/quotes.service.js');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  resetStore();
  const { __resetMockProvider } = await mock();
  const { __resetAiQuota } = await quota();
  const { __resetQuoteState } = await quotes();
  __resetMockProvider();
  __resetAiQuota();
  __resetQuoteState();
});

afterEach(() => {
  vi.useRealTimers();
});

function session(userId: string): string {
  return `${AUTH_COOKIES.access.name}=${signAccessToken(userId)}`;
}

async function getQuoteReq(category: string, userId: string = OWNER) {
  const response = await request(app).get(`${BASE}/${category}`).set('Cookie', session(userId));
  return { response, body: response.body as SuccessBody<QuoteResult> };
}

// PLACEHOLDER_TESTS

describe('access and validation (ARCHITECTURE.md §7)', () => {
  it('returns the quote envelope for each of the three categories', async () => {
    seedUser({ id: OWNER });

    for (const category of ['transactions', 'budgets', 'goals']) {
      const { response, body } = await getQuoteReq(category);

      expect(response.status).toBe(200);
      expect(body.data.category).toBe(category);
      expect(typeof body.data.quote).toBe('string');
      expect(body.data.quote.length).toBeGreaterThan(0);
      expect(body.data.disclaimer).toBe(QUOTE_DISCLAIMER);
      // A cold cache serves a curated line while generation runs in the background (§9).
      expect(body.data.source).toBe('fallback');
    }
  });

  it('rejects an unknown category with 400 VALIDATION_ERROR (R-V1)', async () => {
    seedUser({ id: OWNER });
    const { __getMockCalls } = await mock();

    const response = await request(app).get(`${BASE}/savings`).set('Cookie', session(OWNER));
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Rejected before the service (and therefore any generation) runs.
    expect(__getMockCalls()).toHaveLength(0);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await request(app).get(`${BASE}/goals`);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('does NOT require a verified email — an unverified account succeeds', async () => {
    seedUser({ id: OWNER, emailVerified: false });

    const { response, body } = await getQuoteReq('transactions');

    expect(response.status).toBe(200);
    expect(body.data.category).toBe('transactions');
  });
});

describe('generation, caching and the in-flight guard (D11)', () => {
  it('serves a fallback on the cold miss, then the cached AI line to the next caller with one call', async () => {
    seedUser({ id: OWNER });
    const { __setMockResponses, __getMockCalls } = await mock();
    const { __whenQuoteSettled } = await quotes();
    __setMockResponses(GOALS_QUOTE);

    // First hit: cold cache → curated fallback returned now, one background generation kicked off.
    const first = await getQuoteReq('goals');
    expect(first.body.data.source).toBe('fallback');

    await __whenQuoteSettled('goals');

    // Next hit: the fresh cached line is served, and no second generation was needed.
    const second = await getQuoteReq('goals');
    expect(second.body.data.source).toBe('ai');
    expect(second.body.data.quote).toBe(GOALS_QUOTE_TEXT);
    expect(__getMockCalls()).toHaveLength(1);
  });

  it('collapses concurrent misses into a single generation (thundering-herd guard)', async () => {
    const { __setMockResponses, __getMockCalls } = await mock();
    const { getQuote, __whenQuoteSettled } = await quotes();
    __setMockResponses(GOALS_QUOTE);

    // Two misses in the same tick: both are answered a fallback immediately…
    const a = getQuote('goals');
    const b = getQuote('goals');
    expect(a.source).toBe('fallback');
    expect(b.source).toBe('fallback');

    await __whenQuoteSettled('goals');

    // …but only one generation actually ran.
    expect(__getMockCalls()).toHaveLength(1);
    expect(getQuote('goals').source).toBe('ai');
  });
});

describe('every generation failure falls back to a curated line, never an error (§9)', () => {
  it('falls back when the provider is unavailable', async () => {
    seedUser({ id: OWNER });
    const { __failNextMockCall } = await mock();
    const { __whenQuoteSettled } = await quotes();
    __failNextMockCall();

    const first = await getQuoteReq('goals');
    await __whenQuoteSettled('goals');
    const second = await getQuoteReq('goals');

    expect(first.response.status).toBe(200);
    expect(first.body.data.source).toBe('fallback');
    // The failed generation left the cache empty, so the next caller is still served a fallback.
    expect(second.response.status).toBe(200);
    expect(second.body.data.source).toBe('fallback');
  });

  it('falls back when the model output is not valid JSON', async () => {
    seedUser({ id: OWNER });
    const { __setMockResponses } = await mock();
    const { __whenQuoteSettled } = await quotes();
    __setMockResponses('this is not json', 'still not json');

    await getQuoteReq('goals');
    await __whenQuoteSettled('goals');
    const { body } = await getQuoteReq('goals');

    expect(body.data.source).toBe('fallback');
  });

  it('falls back when the generated line is over the word cap', async () => {
    seedUser({ id: OWNER });
    const { __setMockResponses } = await mock();
    const { __whenQuoteSettled } = await quotes();
    const tooLong = Array<string>(40).fill('word').join(' ');
    __setMockResponses(JSON.stringify({ quote: tooLong, category: 'goals' }));

    await getQuoteReq('goals');
    await __whenQuoteSettled('goals');
    const { body } = await getQuoteReq('goals');

    expect(body.data.source).toBe('fallback');
  });

  it('falls back when the model tags the line for a different section', async () => {
    seedUser({ id: OWNER });
    const { __setMockResponses } = await mock();
    const { __whenQuoteSettled } = await quotes();
    // A well-formed line, but tagged for budgets when goals was asked → rejected as a miss.
    __setMockResponses(JSON.stringify({ quote: GOALS_QUOTE_TEXT, category: 'budgets' }));

    await getQuoteReq('goals');
    await __whenQuoteSettled('goals');
    const { body } = await getQuoteReq('goals');

    expect(body.data.source).toBe('fallback');
  });
});


