/**
 * The provider-independent seam for AI (ARCHITECTURE.md §8, R-I2). Feature code depends only on
 * these types; it never imports a concrete provider. Adding a provider is one adapter file that
 * implements `AIProvider` plus one env change (`AI_PROVIDER`) — nothing else moves (D6).
 */

/** Token accounting a provider reports back. All optional — some free tiers omit usage. */
export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * One generation request. `system` and `user` are already-built strings: the AI Service composes
 * the fixed system prompt and the delimiter-wrapped, aggregate-only user content (R-I1, R-I3)
 * before it reaches a provider. `jsonMode` asks the provider to return strict JSON (R-I4).
 */
export interface AIGenerateParams {
  system: string;
  user: string;
  jsonMode: boolean;
  maxTokens: number;
}

/** What every provider returns: the raw text (untrusted until validated, R-I4) and usage. */
export interface AIGenerateResult {
  text: string;
  usage: AIUsage;
}

/** The one interface every provider implements. */
export interface AIProvider {
  /** Stable identifier, matched against `AI_PROVIDER`; also used in logs (never with keys). */
  readonly name: AIProviderName;
  generate(params: AIGenerateParams): Promise<AIGenerateResult>;
}

/** The providers the app knows how to build. Mirrors the `AI_PROVIDER` env enum. */
export type AIProviderName = 'gemini' | 'groq' | 'openrouter' | 'mock';

/**
 * A typed provider failure: an unconfigured key, a non-2xx upstream, a timeout, or an
 * unparseable envelope. The AI Service maps any of these to `AI_UNAVAILABLE` (503) without a
 * repair retry — repair is only for output that arrived but failed validation.
 */
export class AIProviderError extends Error {
  constructor(
    readonly provider: AIProviderName,
    message: string,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}
