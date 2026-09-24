import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  __resetAiQuota,
  generateStructured,
  getProvider,
  resolveProviderName,
  selectProvider,
} from '../src/ai/ai.service.js';
import {
  __failNextMockCall,
  __getMockCalls,
  __resetMockProvider,
  __setMockResponses,
  mockProvider,
} from '../src/ai/mock.provider.js';
import { AppError } from '../src/lib/app-error.js';

/**
 * AI Service unit suite (Phase 10, R-T4/R-T6). No network and no database: the provider is the
 * in-memory mock, whose responses each test queues, and the clock is injected so quota windows
 * advance deterministically. Env defaults apply: AI_HOURLY_LIMIT=15, AI_DAILY_LIMIT=50.
 */

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

const schema = z.object({ ok: z.boolean() });
const VALID = JSON.stringify({ ok: true });
const INVALID_SHAPE = JSON.stringify({ ok: 'nope' });
const NOT_JSON = 'sorry, here is your answer in prose';

function request() {
  return { system: 'SYS', user: 'USER', schema };
}

/** Every test starts from a clean quota log and an empty mock (R-T6). */
afterEach(() => {
  __resetAiQuota();
  __resetMockProvider();
});

// PLACEHOLDER_TESTS
describe('provider selection (D6: switch via env only)', () => {
  it('maps every provider name to a distinct adapter', () => {
    expect(selectProvider('gemini').name).toBe('gemini');
    expect(selectProvider('groq').name).toBe('groq');
    expect(selectProvider('openrouter').name).toBe('openrouter');
    expect(selectProvider('mock').name).toBe('mock');
  });

  it('defaults to the mock provider under NODE_ENV=test', () => {
    expect(resolveProviderName()).toBe('mock');
    expect(getProvider().name).toBe('mock');
  });
});

describe('generateStructured — output handling (R-I4)', () => {
  it('returns validated data when the first reply is valid JSON', async () => {
    __setMockResponses(VALID);
    const result = await generateStructured('usr_a', request(), { provider: mockProvider });
    expect(result.data).toEqual({ ok: true });
    expect(result.provider).toBe('mock');
    expect(__getMockCalls()).toHaveLength(1);
  });

  it('repairs once when the first reply is malformed, then succeeds', async () => {
    __setMockResponses(NOT_JSON, VALID);
    const result = await generateStructured('usr_a', request(), { provider: mockProvider });
    expect(result.data).toEqual({ ok: true });

    const calls = __getMockCalls();
    expect(calls).toHaveLength(2); // one retry only
    expect(calls[1]?.user).toContain('corrected JSON'); // second call carries the repair prompt
  });

  it('gives up with AI_UNAVAILABLE (503) after the repair retry also fails', async () => {
    __setMockResponses(NOT_JSON, INVALID_SHAPE);
    await expect(generateStructured('usr_a', request(), { provider: mockProvider })).rejects.toEqual(
      expect.objectContaining({ code: 'AI_UNAVAILABLE', status: 503 }),
    );
    expect(__getMockCalls()).toHaveLength(2);
  });

  it('maps a provider failure to AI_UNAVAILABLE without a repair retry', async () => {
    __failNextMockCall('upstream down');
    await expect(generateStructured('usr_a', request(), { provider: mockProvider })).rejects.toEqual(
      expect.objectContaining({ code: 'AI_UNAVAILABLE' }),
    );
    expect(__getMockCalls()).toHaveLength(1); // no second attempt on a provider error
  });
});

// PLACEHOLDER_QUOTA_TESTS
describe('generateStructured — per-user quota (R-B10 / R-I6)', () => {
  const gen = (userId: string, now: number) =>
    generateStructured(userId, request(), { provider: mockProvider, now });

  it('blocks the 16th request in an hour with 429 and a retryAfter', async () => {
    __setMockResponses(...Array<string>(16).fill(VALID));
    const now = 1_000_000_000_000;
    for (let i = 0; i < 15; i += 1) {
      await gen('usr_h', now);
    }

    const error = (await gen('usr_h', now).catch((e: unknown) => e)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.details).toMatchObject({ retryAfter: expect.any(Number) as number });
    expect((error.details as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  });

  it('lets the quota recover once the hour window has passed', async () => {
    __setMockResponses(...Array<string>(17).fill(VALID));
    const now = 2_000_000_000_000;
    for (let i = 0; i < 15; i += 1) {
      await gen('usr_r', now);
    }
    await expect(gen('usr_r', now)).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const recovered = await gen('usr_r', now + HOUR_MS + 1);
    expect(recovered.data).toEqual({ ok: true });
  });

  it('keeps one user’s quota separate from another’s', async () => {
    __setMockResponses(...Array<string>(20).fill(VALID));
    const now = 5_000_000_000_000;
    for (let i = 0; i < 15; i += 1) {
      await gen('usr_x', now);
    }
    await expect(gen('usr_x', now)).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const other = await gen('usr_y', now);
    expect(other.data).toEqual({ ok: true });
  });
});

// PLACEHOLDER_QUOTA_TESTS_2
describe('generateStructured — quota accounting details', () => {
  const gen = (userId: string, now: number) =>
    generateStructured(userId, request(), { provider: mockProvider, now });

  it('blocks the 51st request in a day, spread so the hourly cap never trips first', async () => {
    __setMockResponses(...Array<string>(60).fill(VALID));
    const base = 3_000_000_000_000;
    // 6-minute spacing → at most ~10 calls in any rolling hour (< 15), 50 calls span 5h (< 24h).
    for (let i = 0; i < 50; i += 1) {
      await gen('usr_d', base + i * 6 * MIN_MS);
    }

    const error = (await gen('usr_d', base + 50 * 6 * MIN_MS).catch((e: unknown) => e)) as AppError;
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('charges a repair retry as a single quota unit, not two', async () => {
    const now = 4_000_000_000_000;
    // First generation repairs once (2 provider calls) but must cost only 1 unit.
    __setMockResponses(NOT_JSON, VALID, ...Array<string>(20).fill(VALID));

    await gen('usr_q', now); // 1 unit despite two provider calls
    for (let i = 0; i < 14; i += 1) {
      await gen('usr_q', now); // 14 more → 15 total, all must succeed
    }

    // The 16th is the first to exceed the hourly cap — proving the repair cost only one unit.
    await expect(gen('usr_q', now)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});



