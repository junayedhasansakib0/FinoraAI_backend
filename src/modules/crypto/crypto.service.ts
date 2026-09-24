import {
  fetchMarketsByIds,
  fetchTopMarkets,
  searchCoins,
  type CoinMarket,
  type CoinSearchResult,
} from '../../integrations/coingecko.client.js';
import type { ListMarketsQuery } from './crypto.validation.js';

/**
 * Crypto business logic (Phase 9). This layer holds no data of its own: it shapes the two page
 * needs onto the CoinGecko integration, which owns the cache → timeout → retry → typed-failure
 * pipeline (R-E3). There is no `userId` here because the data is public market data, not user rows.
 */

/** A search resolves to at most this many priced cards, keeping the response bounded (R-B8). */
const SEARCH_RESULT_LIMIT = 25;

/**
 * The markets list. A blank search is the default top-coins page; a search first resolves matching
 * coin ids, then fetches their market rows so the results still carry price and 24h change.
 */
export async function getMarketList(query: ListMarketsQuery): Promise<CoinMarket[]> {
  if (query.search === undefined) {
    return fetchTopMarkets(query.page);
  }

  const matches = await searchCoins(query.search);
  const ids = matches.slice(0, SEARCH_RESULT_LIMIT).map((coin) => coin.id);

  if (ids.length === 0) {
    return [];
  }

  return fetchMarketsByIds(ids);
}

/** The lightweight name/symbol search used for typeahead — no prices, just enough to pick a coin. */
export async function getCoinSearch(query: string): Promise<CoinSearchResult[]> {
  const matches = await searchCoins(query);

  return matches.slice(0, SEARCH_RESULT_LIMIT);
}
