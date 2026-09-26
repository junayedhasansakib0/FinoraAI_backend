import { z } from 'zod';

import { AI_PROVIDER_TIMEOUT_MS } from '../config/constants.js';
import { env } from '../config/env.js';

import { AI_PROVIDER_ENDPOINTS } from './provider-config.js';
import {
  AIProviderError,
  type AIGenerateParams,
  type AIGenerateResult,
  type AIProvider,
} from './types.js';

/**
 * Gemini (Google AI Studio) — the primary provider (PROJECT_CONTEXT.md §6). Called over plain
 * REST with `fetch`, so no SDK dependency is added (R-P1). The key is read only from server env,
 * sent as a header, and NEVER logged or returned to the client (R-A4). Free tier verified R-E5
 * (see phase notes): the `gemini-flash-latest` alias (see `provider-config.ts`) tracks the current
 * free Flash model, ~10 RPM / 250 RPD — the per-user quota sits well inside it, and free-tier
 * inputs may be used to improve the product, which is why only aggregates are ever sent (R-I1).
 * Output is informational, never presented as real-time financial advice (R-I5).
 */

/** Endpoint and model come from the single provider-config table (`provider-config.ts`). */
const { endpoint: BASE_URL, model: MODEL } = AI_PROVIDER_ENDPOINTS.gemini;

/** Only the fields we consume; Gemini sends much more and it is ignored. */
const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string() })).optional() }).optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
});

function extractText(parsed: z.infer<typeof responseSchema>): string {
  const parts = parsed.candidates?.[0]?.content?.parts;
  if (parts === undefined || parts.length === 0) {
    throw new AIProviderError('gemini', 'response contained no text');
  }
  return parts.map((part) => part.text).join('');
}

// PLACEHOLDER_PROVIDER
export const geminiProvider: AIProvider = {
  name: 'gemini',
  async generate(params: AIGenerateParams): Promise<AIGenerateResult> {
    const key = env.GEMINI_API_KEY;
    if (key === undefined || key.length === 0) {
      throw new AIProviderError('gemini', 'GEMINI_API_KEY is not configured');
    }

    const body = {
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: 'user', parts: [{ text: params.user }] }],
      generationConfig: {
        maxOutputTokens: params.maxTokens,
        temperature: 0.3,
        ...(params.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    };

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      // Network error or the 20s ceiling — no status to inspect.
      throw new AIProviderError(
        'gemini',
        error instanceof Error ? error.message : 'request failed',
      );
    }

    if (!response.ok) {
      // Status only; the body may echo the key or prompt, so it is never logged (R-A4). The status
      // is carried on the error so the live smoke test can classify 401/403/404/429 (R-E5).
      throw new AIProviderError('gemini', `gemini responded ${String(response.status)}`, response.status);
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AIProviderError('gemini', 'response envelope was not in the expected shape');
    }

    return {
      text: extractText(parsed.data),
      usage: {
        inputTokens: parsed.data.usageMetadata?.promptTokenCount,
        outputTokens: parsed.data.usageMetadata?.candidatesTokenCount,
      },
    };
  },
};
