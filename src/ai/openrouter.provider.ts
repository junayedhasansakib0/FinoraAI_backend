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
 * OpenRouter — an optional fallback provider (PROJECT_CONTEXT.md §6), implemented behind the
 * `AI_PROVIDER` switch (D6). OpenAI-compatible chat/completions over `fetch` (no SDK, R-P1).
 * Key is server-only and never logged (R-A4). Uses a `:free` model (R-E5, see phase notes):
 * free daily caps are strict but sit above the per-user quota. Aggregates only (R-I1).
 */

/** Endpoint and model come from the single provider-config table (`provider-config.ts`). */
const { endpoint: ENDPOINT, model: MODEL } = AI_PROVIDER_ENDPOINTS.openrouter;

const responseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).optional() }))
    .optional(),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
});

function extractText(parsed: z.infer<typeof responseSchema>): string {
  const content = parsed.choices?.[0]?.message?.content;
  if (content === undefined || content === null || content.length === 0) {
    throw new AIProviderError('openrouter', 'response contained no text');
  }
  return content;
}

// PLACEHOLDER_PROVIDER
export const openRouterProvider: AIProvider = {
  name: 'openrouter',
  async generate(params: AIGenerateParams): Promise<AIGenerateResult> {
    const key = env.OPENROUTER_API_KEY;
    if (key === undefined || key.length === 0) {
      throw new AIProviderError('openrouter', 'OPENROUTER_API_KEY is not configured');
    }

    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      max_tokens: params.maxTokens,
      temperature: 0.3,
      ...(params.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AIProviderError(
        'openrouter',
        error instanceof Error ? error.message : 'request failed',
      );
    }

    if (!response.ok) {
      throw new AIProviderError('openrouter', `openrouter responded ${String(response.status)}`);
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AIProviderError('openrouter', 'response envelope was not in the expected shape');
    }

    return {
      text: extractText(parsed.data),
      usage: {
        inputTokens: parsed.data.usage?.prompt_tokens,
        outputTokens: parsed.data.usage?.completion_tokens,
      },
    };
  },
};
