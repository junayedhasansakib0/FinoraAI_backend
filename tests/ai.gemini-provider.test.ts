import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Gemini adapter regression suite (Phase 10, R-T4). The live providers are mocked everywhere else
 * (the AI Service uses the in-memory mock), so a stale model id or endpoint slips through untested.
 * Here `fetch` is stubbed — no network — to prove the adapter targets exactly what
 * `provider-config.ts` declares and maps a non-2xx upstream to a typed failure (never a throw that
 * leaks the key). It also pins the model away from `gemini-2.5-flash`, which Google retired for new
 * API projects (it answers 404 "no longer available to new users") and which caused the 503s.
 */

// The adapter reads the key from server env at call time; give it a throwaway so it does not
// short-circuit on "not configured". The value is never asserted and never logged (R-A4).
vi.mock('../src/config/env.js', () => ({
  env: { GEMINI_API_KEY: 'test-key-not-real' },
}));

const { geminiProvider } = await import('../src/ai/gemini.provider.js');
const { AI_PROVIDER_ENDPOINTS } = await import('../src/ai/provider-config.js');
const { AIProviderError } = await import('../src/ai/types.js');

const RETIRED_MODEL = 'gemini-2.5-flash';

function geminiEnvelope(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gemini adapter', () => {
  it('is not pinned to the retired gemini-2.5-flash model', () => {
    expect(AI_PROVIDER_ENDPOINTS.gemini.model).not.toBe(RETIRED_MODEL);
  });

  it('calls the endpoint and model declared in provider-config', async () => {
    const { endpoint, model } = AI_PROVIDER_ENDPOINTS.gemini;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(geminiEnvelope(JSON.stringify({ ok: true })));

    const result = await geminiProvider.generate({
      system: 'SYS',
      user: 'USER',
      jsonMode: true,
      maxTokens: 128,
    });

    expect(result.text).toBe(JSON.stringify({ ok: true }));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`${endpoint}/models/${model}:generateContent`);
  });

  it('maps a non-2xx upstream response to a typed AIProviderError carrying the status, never a raw throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"code":403}}', { status: 403 }),
    );

    // A 403 (project denied) must reach the operator's diagnostic as a distinct, safe status —
    // never the response body (which could echo the key, R-A4). The generic client message is the
    // AI Service's job; the adapter's job is to fail typed and carry the number.
    const error = await geminiProvider
      .generate({ system: 'SYS', user: 'USER', jsonMode: true, maxTokens: 128 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AIProviderError);
    if (!(error instanceof AIProviderError)) {
      throw new Error('expected an AIProviderError');
    }
    expect(error.status).toBe(403);
  });
});
