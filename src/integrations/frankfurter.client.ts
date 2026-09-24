import { z } from 'zod';

import { AppError } from '../lib/app-error.js';
import { TtlCache } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

/**
 * Frankfurter FX reference rates (Phase 8). The browser's converter is served only from here; the
 * frontend never calls Frankfurter directly (R-E4). Every call runs the R-E3 pipeline —
 * cache → timeout → one retry → typed failure — serving stale rates (≤24h) when the upstream is
 * down so a hiccup degrades the converter instead of breaking it (ARCHITECTURE.md §9).
 *
 * The data is ECB reference, published once per working day, and is NOT real-time
 * (PROJECT_CONTEXT.md §6). Rates are external reference numbers, not the user's money-of-record,
 * so they travel as `number`, not `Decimal`. No API key is required (R-E5, verified 2026-09-24).
 */

const BASE_URL = 'https://api.frankfurter.dev/v1';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2; // one retry
const RETRY_BASE_DELAY_MS = 300;

/** The contract fixes the fresh window at 6h; stale reaches back a day (R-E6, ARCHITECTURE.md §7). */
const RATES_FRESH_MS = 6 * 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

/** One day's reference rates for a base currency, exactly as the converter needs them. */
export interface FxRates {
  base: string;
  /** The ECB working day the rates belong to, `YYYY-MM-DD`. */
  date: string;
  rates: Record<string, number>;
}

/** Frankfurter also sends `amount`; the object schema strips it, we only need base/date/rates. */
const latestSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

const currenciesSchema = z.record(z.string(), z.string());

const ratesCache = new TtlCache<FxRates>(RATES_FRESH_MS, STALE_MS);
const currenciesCache = new TtlCache<Record<string, string>>(RATES_FRESH_MS, STALE_MS);

/** Separates an upstream that answered badly (some worth a retry) from one that never answered. */
class UpstreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** 429 (rate limited) and 5xx are transient; a well-formed 4xx will answer the same on a retry. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A single GET with an 8s ceiling. A non-2xx answer becomes a typed, maybe-retryable failure. */
async function fetchOnce(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new UpstreamError(
      `frankfurter responded ${String(response.status)}`,
      isRetryableStatus(response.status),
    );
  }

  return response.json();
}

/** `fetchOnce` plus one backoff retry on a transient failure (timeout, network, 429/5xx). */
async function fetchJson(url: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchOnce(url);
    } catch (error) {
      lastError = error;

      // A network/timeout error carries no status, so it is treated as transient and retried once.
      const retryable = error instanceof UpstreamError ? error.retryable : true;

      if (attempt < MAX_ATTEMPTS && retryable) {
        await delay(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      break;
    }
  }

  throw lastError;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * The R-E3 read: fresh cache first, then the network, then stale cache as a last resort, and only
 * a typed 503 when there is nothing to serve (ARCHITECTURE.md §9).
 */
async function loadCached<TValue>(
  cache: TtlCache<TValue>,
  key: string,
  url: string,
  parse: (raw: unknown) => TValue,
): Promise<TValue> {
  const fresh = cache.fresh(key);

  if (fresh !== undefined) {
    return fresh;
  }

  try {
    const value = parse(await fetchJson(url));
    cache.set(key, value);
    return value;
  } catch (error) {
    const stale = cache.stale(key);

    if (stale !== undefined) {
      logger.warn('frankfurter_serving_stale', { key, reason: reasonOf(error) });
      return stale;
    }

    logger.warn('frankfurter_unavailable', { key, reason: reasonOf(error) });
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      'Currency rates are unavailable right now. Please try again shortly.',
    );
  }
}

/**
 * One day's reference rates for `base`. When `symbols` is given the upstream trims the payload to
 * those currencies; otherwise it returns the whole ECB set. The `date` is present either way.
 */
export function fetchRates(base: string, symbols?: string[]): Promise<FxRates> {
  // Sorted so two requests for the same currencies share one cache entry.
  const ordered = symbols === undefined ? [] : [...symbols].sort();
  const params = new URLSearchParams({ base });

  if (ordered.length > 0) {
    params.set('symbols', ordered.join(','));
  }

  return loadCached(
    ratesCache,
    `rates:${base}:${ordered.join(',')}`,
    `${BASE_URL}/latest?${params.toString()}`,
    (raw) => latestSchema.parse(raw),
  );
}

/** The supported currencies as a code→name map — the authoritative list a 400 is checked against. */
export function fetchCurrencies(): Promise<Record<string, string>> {
  return loadCached(currenciesCache, 'currencies', `${BASE_URL}/currencies`, (raw) =>
    currenciesSchema.parse(raw),
  );
}

/** Test-only: clears both caches so one suite's frozen clock cannot leak into the next (R-T6). */
export function __resetFrankfurterCaches(): void {
  ratesCache.clear();
  currenciesCache.clear();
}
