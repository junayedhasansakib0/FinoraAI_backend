import { z } from 'zod';

import { env } from '../config/env.js';
import { AppError } from '../lib/app-error.js';
import { TtlCache } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

/**
 * CoinGecko demo/free market data (Phase 9). The browser's crypto page is served only from here;
 * the frontend never calls CoinGecko directly (R-E4). Every call runs the R-E3 pipeline —
 * cache → timeout → one retry → typed failure — serving stale data (≤24h) when the upstream is
 * down so a hiccup degrades the page instead of breaking it (ARCHITECTURE.md §9).
 *
 * The data is informational and NOT real-time (PROJECT_CONTEXT.md §6). Prices are reference
 * numbers, not the user's money-of-record, so they travel as `number`, not `Decimal`.
 */

const BASE_URL = 'https://api.coingecko.com/api/v3';
const VS_CURRENCY = 'usd';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2; // one retry
const RETRY_BASE_DELAY_MS = 300;

/** How many top coins one markets page carries; bounded so a response never runs away (R-B8). */
const MARKETS_PER_PAGE = 50;

/** Fresh windows sit in the 60–120s band the phase calls for; stale reaches back a day (R-E6). */
const MARKETS_FRESH_MS = 90_000;
const SEARCH_FRESH_MS = 120_000;
const STALE_MS = 24 * 60 * 60 * 1000;

/** One coin as the crypto page needs it. Nulls stand in for figures CoinGecko omits for a coin. */
export interface CoinMarket {
  id: string;
  symbol: string;
  name: string;
  price: number | null;
  change24h: number | null;
  marketCap: number | null;
  rank: number | null;
}

/** A lightweight search hit: enough to name a coin and rank it, no price. */
export interface CoinSearchResult {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
}

/** CoinGecko sends `null` for figures it lacks; `nullish` lets those pass and we map them to null. */
const marketRowSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  current_price: z.number().nullish(),
  price_change_percentage_24h: z.number().nullish(),
  market_cap: z.number().nullish(),
  market_cap_rank: z.number().nullish(),
});

const marketsSchema = z.array(marketRowSchema);

const searchSchema = z.object({
  coins: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      name: z.string(),
      market_cap_rank: z.number().nullish(),
    }),
  ),
});

const marketsCache = new TtlCache<CoinMarket[]>(MARKETS_FRESH_MS, STALE_MS);
const searchCache = new TtlCache<CoinSearchResult[]>(SEARCH_FRESH_MS, STALE_MS);

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

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  // Optional demo key; keyless calls also work on the free tier (R-E5). Never logged (R-A4).
  if (env.COINGECKO_API_KEY !== undefined) {
    headers['x-cg-demo-api-key'] = env.COINGECKO_API_KEY;
  }

  return headers;
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
    headers: buildHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new UpstreamError(
      `coingecko responded ${String(response.status)}`,
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
 * a typed 503 when there is nothing to serve. Upstream detail is logged as metadata; the key
 * material that reached CoinGecko never is (R-A4).
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
      logger.warn('coingecko_serving_stale', { key, reason: reasonOf(error) });
      return stale;
    }

    logger.warn('coingecko_unavailable', { key, reason: reasonOf(error) });
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      'Market data is unavailable right now. Please try again shortly.',
    );
  }
}

function toCoinMarket(row: z.infer<typeof marketRowSchema>): CoinMarket {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    price: row.current_price ?? null,
    change24h: row.price_change_percentage_24h ?? null,
    marketCap: row.market_cap ?? null,
    rank: row.market_cap_rank ?? null,
  };
}

/** Top coins by market cap, one page at a time. */
export function fetchTopMarkets(page: number): Promise<CoinMarket[]> {
  const params = new URLSearchParams({
    vs_currency: VS_CURRENCY,
    order: 'market_cap_desc',
    per_page: String(MARKETS_PER_PAGE),
    page: String(page),
    price_change_percentage: '24h',
  });

  return loadCached(
    marketsCache,
    `markets:page:${String(page)}`,
    `${BASE_URL}/coins/markets?${params.toString()}`,
    (raw) => marketsSchema.parse(raw).map(toCoinMarket),
  );
}

/** The same market rows for a specific set of ids — how a search turns into priced cards. */
export function fetchMarketsByIds(ids: string[]): Promise<CoinMarket[]> {
  // Sorted so two searches that resolve to the same coins share one cache entry.
  const ordered = [...ids].sort();
  const params = new URLSearchParams({
    vs_currency: VS_CURRENCY,
    ids: ordered.join(','),
    order: 'market_cap_desc',
    price_change_percentage: '24h',
  });

  return loadCached(
    marketsCache,
    `markets:ids:${ordered.join(',')}`,
    `${BASE_URL}/coins/markets?${params.toString()}`,
    (raw) => marketsSchema.parse(raw).map(toCoinMarket),
  );
}

/** Name/symbol search. Returns the coins CoinGecko matched, most-relevant first. */
export function searchCoins(query: string): Promise<CoinSearchResult[]> {
  const params = new URLSearchParams({ query });

  return loadCached(
    searchCache,
    `search:${query.toLowerCase()}`,
    `${BASE_URL}/search?${params.toString()}`,
    (raw) =>
      searchSchema.parse(raw).coins.map((coin) => ({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        rank: coin.market_cap_rank ?? null,
      })),
  );
}

/** Test-only: clears both caches so one suite's frozen clock cannot leak into the next (R-T6). */
export function __resetCoinGeckoCaches(): void {
  marketsCache.clear();
  searchCache.clear();
}

