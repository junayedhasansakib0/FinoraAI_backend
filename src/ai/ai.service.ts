import type { ZodType } from 'zod';

import {
  AI_DAILY_WINDOW_MS,
  AI_HOURLY_WINDOW_MS,
  AI_MAX_GENERATION_ATTEMPTS,
  AI_MAX_OUTPUT_TOKENS,
} from '../config/constants.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

import { geminiProvider } from './gemini.provider.js';
import { groqProvider } from './groq.provider.js';
import { mockProvider } from './mock.provider.js';
import { openRouterProvider } from './openrouter.provider.js';
import type {
  AIGenerateResult,
  AIProvider,
  AIProviderName,
  AIUsage,
} from './types.js';

/**
 * The AI Service (ARCHITECTURE.md §8): the one place feature code reaches AI through. It selects
 * the provider from env (R-I2 / D6), enforces the per-user quota (R-B10 / R-I6), and treats
 * provider output as untrusted — JSON parse → Zod → exactly one repair retry → else
 * `AI_UNAVAILABLE` (R-I4). It never touches Prisma; callers hand it already-built,
 * aggregate-only prompts (R-I1).
 */

/** The registry is the single switch point: a new provider is one entry + one adapter file (D6). */
const REGISTRY: Record<AIProviderName, AIProvider> = {
  gemini: geminiProvider,
  groq: groqProvider,
  openrouter: openRouterProvider,
  mock: mockProvider,
};

/** The active provider name comes only from env; mock is the safe default under test (R-T4). */
export function resolveProviderName(): AIProviderName {
  return env.AI_PROVIDER ?? (env.isTest ? 'mock' : 'gemini');
}

/** Look up a provider adapter by name (exported so a test can prove the env switch, D6). */
export function selectProvider(name: AIProviderName): AIProvider {
  return REGISTRY[name];
}

/** The provider the service uses right now, chosen by env alone. */
export function getProvider(): AIProvider {
  return selectProvider(resolveProviderName());
}

// PLACEHOLDER_QUOTA
/**
 * Per-user generation timestamps (ms), oldest-first. In-memory is enough: the quota is best-effort
 * back-pressure that resets on restart, and the free-tier deployment is single-instance (D8). It
 * is the limit a user meets first — the providers' own free tiers sit far above it.
 */
const usageLog = new Map<string, number[]>();

interface QuotaDenial {
  retryAfter: number;
}

/** Reserve one generation for the user, or throw RATE_LIMITED with `retryAfter` (R-B10 / R-I6). */
function reserveQuota(userId: string, now: number): void {
  const recent = (usageLog.get(userId) ?? []).filter((ts) => now - ts < AI_DAILY_WINDOW_MS);
  const inHour = recent.filter((ts) => now - ts < AI_HOURLY_WINDOW_MS);

  const denial = denyIfOverLimit(recent, inHour, now);
  if (denial !== null) {
    throw new AppError('RATE_LIMITED', 'AI request limit reached. Please try again later.', denial);
  }

  recent.push(now);
  usageLog.set(userId, recent);
}

/** Hourly cap is checked first, then the daily cap; `retryAfter` points at the earliest reset. */
function denyIfOverLimit(recent: number[], inHour: number[], now: number): QuotaDenial | null {
  if (inHour.length >= env.AI_HOURLY_LIMIT) {
    return { retryAfter: retryAfterSeconds((inHour[0] ?? now) + AI_HOURLY_WINDOW_MS, now) };
  }
  if (recent.length >= env.AI_DAILY_LIMIT) {
    return { retryAfter: retryAfterSeconds((recent[0] ?? now) + AI_DAILY_WINDOW_MS, now) };
  }
  return null;
}

function retryAfterSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

// PLACEHOLDER_GENERATE
export interface StructuredRequest<T> {
  /** Fixed, server-side system prompt (R-I3). */
  system: string;
  /** Already-built, aggregate-only user content (R-I1). */
  user: string;
  /** The shape the output must satisfy; anything else is treated as invalid (R-I4). */
  schema: ZodType<T>;
  maxTokens?: number;
}

export interface StructuredResult<T> {
  data: T;
  usage: AIUsage;
  provider: AIProviderName;
}

export interface GenerateOptions {
  /** Overrides the env-selected provider; tests inject the mock here. */
  provider?: AIProvider;
  /** Injected clock for deterministic quota tests (R-T6). */
  now?: number;
}

/** Providers under `jsonMode` return raw JSON, but a stray ```json fence is stripped defensively. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(stripFences(text)) as unknown };
  } catch {
    return { ok: false };
  }
}

function repairPrompt(original: string, previous: string, issues: string): string {
  return [
    original,
    '',
    'Your previous reply was not valid JSON matching the required schema.',
    `Problems: ${issues}`,
    'Reply again with ONLY the corrected JSON object and nothing else.',
    'Previous reply:',
    previous,
  ].join('\n');
}

// PLACEHOLDER_RUN
/**
 * Generate a structured, schema-validated result for one user. Reserves one quota unit up front —
 * a repair retry does NOT cost a second unit — then: a provider failure → `AI_UNAVAILABLE`
 * immediately (no repair); output that parses and validates → return it; invalid output → one
 * repair retry; still invalid → `AI_UNAVAILABLE` (R-I4). Never logs prompts, output, or keys.
 */
export async function generateStructured<T>(
  userId: string,
  request: StructuredRequest<T>,
  options: GenerateOptions = {},
): Promise<StructuredResult<T>> {
  const now = options.now ?? Date.now();
  reserveQuota(userId, now);

  const provider = options.provider ?? getProvider();
  const maxTokens = request.maxTokens ?? AI_MAX_OUTPUT_TOKENS;
  let previousText = '';
  let lastIssues = 'output was not valid JSON';

  for (let attempt = 1; attempt <= AI_MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const user =
      attempt === 1 ? request.user : repairPrompt(request.user, previousText, lastIssues);

    let result: AIGenerateResult;
    try {
      result = await provider.generate({ system: request.system, user, jsonMode: true, maxTokens });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      logger.warn('ai_provider_error', { provider: provider.name, reason });
      throw new AppError(
        'AI_UNAVAILABLE',
        'The AI service is unavailable right now. Please try again shortly.',
      );
    }

    const parsed = tryParseJson(result.text);
    if (parsed.ok) {
      const validated = request.schema.safeParse(parsed.value);
      if (validated.success) {
        return { data: validated.data, usage: result.usage, provider: provider.name };
      }
      lastIssues = validated.error.issues.map((issue) => issue.message).join('; ');
    } else {
      lastIssues = 'output was not valid JSON';
    }

    previousText = result.text;
    if (attempt < AI_MAX_GENERATION_ATTEMPTS) {
      logger.warn('ai_output_repair', { provider: provider.name });
    }
  }

  logger.warn('ai_unavailable', { provider: provider.name });
  throw new AppError(
    'AI_UNAVAILABLE',
    'The AI response could not be processed. Please try again shortly.',
  );
}

/** Test-only: clears the in-memory quota log so one suite's clock cannot leak into the next (R-T6). */
export function __resetAiQuota(): void {
  usageLog.clear();
}


