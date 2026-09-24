import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import { getCoinSearch, getMarketList } from './crypto.service.js';
import type { ListMarketsQuery, SearchCoinsQuery } from './crypto.validation.js';

/**
 * Transport layer for `/crypto`. An upstream failure surfaces as an `AppError` thrown from the
 * service and reaches the central error handler through Express 5's async support (503
 * UPSTREAM_UNAVAILABLE), so there is no per-handler try/catch. No `getUserId` scoping: the data is
 * public market data, and the per-user rate limit already sits on the router.
 */

export async function markets(req: Request, res: Response): Promise<void> {
  const query = getValidatedQuery<ListMarketsQuery>(req);

  sendSuccess(res, 200, { coins: await getMarketList(query) });
}

export async function search(req: Request, res: Response): Promise<void> {
  const query = getValidatedQuery<SearchCoinsQuery>(req);

  sendSuccess(res, 200, { coins: await getCoinSearch(query.q) });
}
