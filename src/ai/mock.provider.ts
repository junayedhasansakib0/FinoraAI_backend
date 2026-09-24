import { AIProviderError, type AIGenerateParams, type AIGenerateResult, type AIProvider } from './types.js';

/**
 * Deterministic provider for development and automated tests (R-T4). It never touches the
 * network, so CI never spends a metered free tier. Tests queue the exact text a real provider
 * would return, then assert the AI Service's parse/validate/repair/quota behaviour around it;
 * captured calls let later phases assert that only aggregates — never raw transactions or PII —
 * reached the model (R-I1).
 */

/** FIFO of responses the next `generate` calls will return, in order. */
let responseQueue: string[] = [];

/** Every call's params, in order, for assertions in tests. */
const calls: AIGenerateParams[] = [];

/** When set, the next `generate` rejects with a provider error (exercises the 503 path). */
let failure: string | null = null;

/** A benign default when the queue is empty: valid JSON, but not shaped like any report schema. */
const DEFAULT_RESPONSE = JSON.stringify({ note: 'mock provider: no response queued' });

export const mockProvider: AIProvider = {
  name: 'mock',
  generate(params: AIGenerateParams): Promise<AIGenerateResult> {
    calls.push(params);

    if (failure !== null) {
      const message = failure;
      failure = null;
      return Promise.reject(new AIProviderError('mock', message));
    }

    const text = responseQueue.shift() ?? DEFAULT_RESPONSE;
    return Promise.resolve({
      text,
      // Rough char-based estimate; only the shape matters for the mock.
      usage: {
        inputTokens: Math.ceil((params.system.length + params.user.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
    });
  },
};

/** Test/dev helper: queue the raw text the mock returns for the next call(s), in order. */
export function __setMockResponses(...texts: string[]): void {
  responseQueue = [...texts];
}

/** Test helper: make the very next `generate` reject, simulating an upstream failure. */
export function __failNextMockCall(message = 'mock provider failure'): void {
  failure = message;
}

/** Test helper: the params of every call since the last reset, in order. */
export function __getMockCalls(): readonly AIGenerateParams[] {
  return calls;
}

/** Test helper: clear queued responses, captured calls, and any pending failure (R-T6). */
export function __resetMockProvider(): void {
  responseQueue = [];
  calls.length = 0;
  failure = null;
}
