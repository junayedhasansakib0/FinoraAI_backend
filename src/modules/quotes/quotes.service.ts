import { generateStructured } from '../../ai/ai.service.js';
import { TtlCache } from '../../lib/cache.js';
import { logger } from '../../lib/logger.js';

import {
  buildQuoteUserPrompt,
  QUOTE_CACHE_FRESH_MS,
  QUOTE_CACHE_STALE_MS,
  QUOTE_DISCLAIMER,
  QUOTE_FALLBACKS,
  QUOTE_HISTORY_SIZE,
  QUOTE_QUOTA_KEY,
  QUOTE_SYSTEM_PROMPT,
  type QuoteCategory,
  type QuoteResult,
} from './quotes.constants.js';
import { quoteOutputSchema } from './quotes.validation.js';

/**
 * The quotes service (ARCHITECTURE.md §7, §9; D11/D12). It owns a *global* per-category cache of one
 * generic, public quote line (no user data, R-I1), an in-flight guard so concurrent misses trigger
 * only one generation (thundering-herd), and a small recent-history buffer fed back to the model to
 * avoid repeats. It reaches the model only through the shared AI seam (R-I2) under a dedicated quota
 * key (D12), and it **never lets a generation failure reach the client**: on any error, timeout,
 * quota, or unusable output the request is served a curated fallback line with HTTP 200 (§9).
 */

/** One shared line per category; fresh for ~12h, stale-servable for ~another 12h (D11). */
const cache = new TtlCache<QuoteResult>(QUOTE_CACHE_FRESH_MS, QUOTE_CACHE_STALE_MS);

/** Categories currently regenerating, so a second miss joins the first rather than firing again. */
const inFlight = new Map<QuoteCategory, Promise<void>>();

/** Recent generated lines per category, oldest-first, fed back to the model to avoid repeats. */
const history = new Map<QuoteCategory, string[]>();

/** Pick a curated fallback line for the category, rotating by the clock so it is not always the same. */
function fallbackResult(category: QuoteCategory): QuoteResult {
  const lines = QUOTE_FALLBACKS[category];
  // A slow rotation (per fresh window) keeps the fallback from looking frozen without any state.
  const index = Math.floor(Date.now() / QUOTE_CACHE_FRESH_MS) % lines.length;
  return {
    quote: lines[index] ?? lines[0] ?? '',
    category,
    source: 'fallback',
    disclaimer: QUOTE_DISCLAIMER,
  };
}

/**
 * Generate one fresh line for the category and cache it. Every failure path — provider down, quota
 * spent, timeout, malformed output, off-category, out-of-bounds — is swallowed here: the cache is
 * simply left as it was, so the fallback (or the last stale line) keeps serving. Never throws.
 */
async function runRegeneration(category: QuoteCategory): Promise<void> {
  const recent = history.get(category) ?? [];

  try {
    const result = await generateStructured(QUOTE_QUOTA_KEY, {
      system: QUOTE_SYSTEM_PROMPT,
      user: buildQuoteUserPrompt(category, recent),
      schema: quoteOutputSchema,
    });

    // The schema already bounds length and word count; reject a line the model tagged for another
    // section so a mismatched quote is never shown (treated as a miss → fallback keeps serving).
    if (result.data.category !== undefined && result.data.category !== category) {
      logger.warn('quote_off_category', { category, tagged: result.data.category });
      return;
    }

    const quote = result.data.quote.trim();
    history.set(category, [...recent, quote].slice(-QUOTE_HISTORY_SIZE));
    cache.set(category, { quote, category, source: 'ai', disclaimer: QUOTE_DISCLAIMER });
  } catch {
    // AI_UNAVAILABLE / RATE_LIMITED / timeout / unusable output — all decorative, all ignored (§9).
    logger.warn('quote_generation_failed', { category });
  }
}

/** Start (or join) a single background regeneration for the category. Never throws to the caller. */
function regenerate(category: QuoteCategory): Promise<void> {
  const existing = inFlight.get(category);
  if (existing !== undefined) {
    return existing;
  }

  const promise = runRegeneration(category).finally(() => {
    inFlight.delete(category);
  });
  inFlight.set(category, promise);
  return promise;
}

/**
 * The one entry point (called by the controller). A fresh cached line is returned as-is. Otherwise
 * the caller is answered *immediately* with the last stale line or a curated fallback, and a single
 * background regeneration is kicked off to refresh the cache for the next caller — so this request
 * is never delayed by, and never fails because of, the model (§9).
 */
export function getQuote(category: QuoteCategory): QuoteResult {
  const fresh = cache.fresh(category);
  if (fresh !== undefined) {
    return fresh;
  }

  void regenerate(category);
  return cache.stale(category) ?? fallbackResult(category);
}

/** Test-only: clear the cache, in-flight guards, and history so one suite cannot leak into the next (R-T6). */
export function __resetQuoteState(): void {
  cache.clear();
  inFlight.clear();
  history.clear();
}

/** Test-only: await any in-flight background regeneration so a test can then assert the cache filled. */
export async function __whenQuoteSettled(category: QuoteCategory): Promise<void> {
  await inFlight.get(category);
}
