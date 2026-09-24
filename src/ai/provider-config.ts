import { env } from '../config/env.js';

import type { AIProviderName } from './types.js';

/**
 * Where each live AI provider is called and which model it requests, in one place (D6). The
 * adapters (`gemini`/`groq`/`openrouter`) read their endpoint and model from here so the
 * configured target is obvious at a glance, and the live smoke test (`scripts/smoke.ts`) reports
 * exactly what a deployment will hit.
 *
 * These name external services whose model identifiers and free-tier limits live OUTSIDE this
 * repository and MAY CHANGE without notice — they are verified at deploy, not in CI (R-E5). The
 * `mock` provider is intentionally absent: it never leaves the process, so it has no endpoint.
 */

/** A live provider — every `AIProviderName` except the in-process `mock`. */
export type LiveProviderName = Exclude<AIProviderName, 'mock'>;

export interface AIProviderEndpoint {
  /**
   * The origin/path a call is sent to. For the OpenAI-compatible providers this is the full
   * chat/completions URL; for Gemini it is the REST base, to which the adapter appends
   * `/models/<model>:generateContent`.
   */
  readonly endpoint: string;
  /** The free-tier model the adapter requests (R-E5, verified 2026). */
  readonly model: string;
  /** The env var that must hold this provider's key for a live call to succeed. */
  readonly keyEnvVar: 'GEMINI_API_KEY' | 'GROQ_API_KEY' | 'OPENROUTER_API_KEY';
}

export const AI_PROVIDER_ENDPOINTS: Record<LiveProviderName, AIProviderEndpoint> = {
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    keyEnvVar: 'GEMINI_API_KEY',
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    keyEnvVar: 'GROQ_API_KEY',
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnvVar: 'OPENROUTER_API_KEY',
  },
};

/** Whether a name is a live provider (i.e. not the in-process mock). */
export function isLiveProvider(name: AIProviderName): name is LiveProviderName {
  return name !== 'mock';
}

/**
 * Whether the key the named live provider needs is present. The key value itself is never returned
 * or logged (R-A4) — only this boolean, which the live smoke test uses to fail clearly when a
 * required credential is missing.
 */
export function isProviderKeyConfigured(name: LiveProviderName): boolean {
  const key = env[AI_PROVIDER_ENDPOINTS[name].keyEnvVar];
  return key !== undefined && key.length > 0;
}
