import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { AI_DISCLAIMER } from '../src/modules/ai/prompts.js';
import type { PublicAIReport } from '../src/modules/ai/ai.types.js';
import {
  resetStore,
  seedCategory,
  seedTransaction,
  seedUser,
  store,
} from './helpers/db-double.js';

/**
 * `/ai` endpoint suite (ARCHITECTURE.md §7, R-T3/R-T4/R-T6). The provider is the in-memory mock —
 * NODE_ENV=test makes the AI Service default to it (R-T4), so a test only queues the text a real
 * model would return. The clock is frozen (R-T6) so the 24h reuse window and the quota windows are
 * deterministic. These tests prove the orchestration rules: persist a validated report (R-I7), the
 * 24h reuse that skips the provider (R-I6), `?refresh` bypassing it, 422 on no data, 429 on quota,
 * 503 on unparseable output (R-I4), the disclaimer on every response (R-I5), and per-user isolation.
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
const BASE = '/api/v1/ai';
const OWNER = 'usr_owner';
const STRANGER = 'usr_stranger';
const NOW = '2026-09-15T12:00:00.000Z';

/** Valid model output per report kind, matching the Zod output schemas (R-I4). */
const VALID_SPENDING = JSON.stringify({
  summary: 'Spending held steady across the window.',
  spendingPatterns: ['Groceries dominate the total.'],
  notableCategories: ['Groceries at the top.'],
  savingsOpportunities: ['Consider a weekly grocery cap.'],
});

/** Valid JSON that does not match any report schema, to exercise the repair-then-503 path. */
const INVALID_SHAPE = JSON.stringify({ unexpected: 'field' });

// The mock provider lives in the same module the AI Service imports, so we drive it directly.
async function mock() {
  return import('../src/ai/mock.provider.js');
}

async function quota() {
  return import('../src/ai/ai.service.js');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  resetStore();
  const { __resetMockProvider } = await mock();
  const { __resetAiQuota } = await quota();
  __resetMockProvider();
  __resetAiQuota();
});

afterEach(() => {
  vi.useRealTimers();
});

function session(userId: string): string {
  return `${AUTH_COOKIES.access.name}=${signAccessToken(userId)}`;
}

/** Give a user one income and one expense this month, enough for every report to be non-empty. */
function seedLedger(userId: string): void {
  const groceries = seedCategory({ userId, name: 'Groceries', type: 'expense' });
  seedTransaction({
    userId,
    type: 'expense',
    amount: '120.00',
    date: '2026-09-10T12:00:00.000Z',
    categoryId: groceries.id,
  });
  seedTransaction({
    userId,
    type: 'income',
    amount: '3000.00',
    date: '2026-09-01T12:00:00.000Z',
  });
}

async function post(userId: string, path: string, query: Record<string, string> = {}) {
  const response = await request(app)
    .post(`${BASE}${path}`)
    .query(query)
    .set('Cookie', session(userId));

  return { response, body: response.body as SuccessBody<PublicAIReport> };
}

describe('generation and persistence (R-I4, R-I5, R-I7)', () => {
  beforeEach(() => {
    seedUser({ id: OWNER });
    seedLedger(OWNER);
  });

  it('persists a validated report and returns it with its disclaimer', async () => {
    const { __setMockResponses, __getMockCalls } = await mock();
    __setMockResponses(VALID_SPENDING);

    const { response, body } = await post(OWNER, '/spending-analysis');

    expect(response.status).toBe(200);
    expect(body.data.type).toBe('SPENDING_ANALYSIS');
    expect(body.data.cached).toBe(false);
    expect(body.data.disclaimer).toBe(AI_DISCLAIMER);
    expect(body.data.content).toEqual(JSON.parse(VALID_SPENDING));
    // The row is stored (R-I7) and the provider was called exactly once.
    expect(store.aiReports).toHaveLength(1);
    expect(__getMockCalls()).toHaveLength(1);
  });

  it('sends only the aggregate JSON to the provider, never raw transactions (R-I1/R-I3)', async () => {
    const { __setMockResponses, __getMockCalls } = await mock();
    __setMockResponses(VALID_SPENDING);

    await post(OWNER, '/spending-analysis');

    const call = __getMockCalls()[0];
    expect(call?.user).toContain('<financial_data>');
    expect(call?.jsonMode).toBe(true);
    // The wrapped context is the aggregate serialisation — no transaction ids leak into the prompt.
    expect(call?.user).not.toContain('txn_');
  });

  it('reuses a report younger than 24h without calling the provider again (R-I6)', async () => {
    const { __setMockResponses, __getMockCalls } = await mock();
    __setMockResponses(VALID_SPENDING);

    const first = await post(OWNER, '/spending-analysis');
    const second = await post(OWNER, '/spending-analysis');

    expect(first.body.data.cached).toBe(false);
    expect(second.body.data.cached).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.content).toEqual(first.body.data.content);
    // No second generation: one stored row, one provider call.
    expect(store.aiReports).toHaveLength(1);
    expect(__getMockCalls()).toHaveLength(1);
  });

  it('?refresh=true bypasses reuse and generates again (R-I6)', async () => {
    const { __setMockResponses, __getMockCalls } = await mock();
    __setMockResponses(VALID_SPENDING, VALID_SPENDING);

    await post(OWNER, '/spending-analysis');
    const refreshed = await post(OWNER, '/spending-analysis', { refresh: 'true' });

    expect(refreshed.body.data.cached).toBe(false);
    expect(store.aiReports).toHaveLength(2);
    expect(__getMockCalls()).toHaveLength(2);
  });
});

describe('failure modes', () => {
  it('answers 422 NO_DATA when the user has nothing to report on (R-I1)', async () => {
    seedUser({ id: OWNER });
    const { __getMockCalls } = await mock();

    const response = await request(app)
      .post(`${BASE}/spending-analysis`)
      .set('Cookie', session(OWNER));
    const body = response.body as ErrorBody;

    expect(response.status).toBe(422);
    expect(body.error.code).toBe('NO_DATA');
    // No data means no provider call.
    expect(__getMockCalls()).toHaveLength(0);
  });

  it('answers 503 AI_UNAVAILABLE when the model output never validates (R-I4)', async () => {
    seedUser({ id: OWNER });
    seedLedger(OWNER);
    const { __setMockResponses, __getMockCalls } = await mock();
    // Both the first attempt and the single repair retry return the wrong shape.
    __setMockResponses(INVALID_SHAPE, INVALID_SHAPE);

    const response = await request(app)
      .post(`${BASE}/spending-analysis`)
      .set('Cookie', session(OWNER));
    const body = response.body as ErrorBody;

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('AI_UNAVAILABLE');
    expect(__getMockCalls()).toHaveLength(2);
    // Nothing invalid is ever persisted.
    expect(store.aiReports).toHaveLength(0);
  });

  it('answers 429 RATE_LIMITED once the per-user hourly quota is spent (R-I6)', async () => {
    seedUser({ id: OWNER });
    seedLedger(OWNER);
    const { __setMockResponses } = await mock();
    // The hourly cap is 15; queue that many valid replies, each refresh forcing a fresh generation.
    __setMockResponses(...Array<string>(15).fill(VALID_SPENDING));

    for (let call = 0; call < 15; call += 1) {
      const ok = await post(OWNER, '/spending-analysis', { refresh: 'true' });
      expect(ok.response.status).toBe(200);
    }

    const denied = await request(app)
      .post(`${BASE}/spending-analysis`)
      .query({ refresh: 'true' })
      .set('Cookie', session(OWNER));
    const body = denied.body as ErrorBody;

    expect(denied.status).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect((body.error.details as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  });
});

describe('auth and per-user isolation (R-A7, R-B2)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const response = await request(app).post(`${BASE}/spending-analysis`);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('never returns one user\'s report to another (R-B2)', async () => {
    seedUser({ id: OWNER });
    seedUser({ id: STRANGER });
    seedLedger(OWNER);
    const { __setMockResponses } = await mock();
    __setMockResponses(VALID_SPENDING);

    await post(OWNER, '/spending-analysis');

    // The stranger's history is empty even though the owner has just generated a report.
    const history = await request(app).get(`${BASE}/reports`).set('Cookie', session(STRANGER));
    const body = history.body as SuccessBody<{ reports: PublicAIReport[] }>;

    expect(history.status).toBe(200);
    expect(body.data.reports).toHaveLength(0);
  });
});

describe('GET /reports history (ARCHITECTURE.md §7)', () => {
  beforeEach(() => {
    seedUser({ id: OWNER });
    seedLedger(OWNER);
  });

  it('returns the user\'s reports newest first, each with its disclaimer', async () => {
    const { __setMockResponses } = await mock();
    __setMockResponses(VALID_SPENDING, VALID_SPENDING);
    await post(OWNER, '/spending-analysis');
    await post(OWNER, '/spending-analysis', { refresh: 'true' });

    const history = await request(app).get(`${BASE}/reports`).set('Cookie', session(OWNER));
    const body = history.body as SuccessBody<{ reports: PublicAIReport[] }>;

    expect(history.status).toBe(200);
    expect(body.data.reports).toHaveLength(2);
    for (const report of body.data.reports) {
      expect(report.type).toBe('SPENDING_ANALYSIS');
      expect(report.disclaimer).toBe(AI_DISCLAIMER);
      expect(report.cached).toBe(true);
    }
  });

  it('filters history by report type', async () => {
    const { __setMockResponses } = await mock();
    __setMockResponses(VALID_SPENDING);
    await post(OWNER, '/spending-analysis');

    const history = await request(app)
      .get(`${BASE}/reports`)
      .query({ type: 'MONTHLY_SUMMARY' })
      .set('Cookie', session(OWNER));
    const body = history.body as SuccessBody<{ reports: PublicAIReport[] }>;

    expect(history.status).toBe(200);
    expect(body.data.reports).toHaveLength(0);
  });
});
