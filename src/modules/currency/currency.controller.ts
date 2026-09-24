import { sendSuccess } from '../../lib/api-response.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import { convert as convertCurrency, getRates } from './currency.service.js';

import type { ConvertQuery, RatesQuery } from './currency.validation.js';
import type { Request, Response } from 'express';

/**
 * Transport layer for `/currency`. An upstream failure surfaces as an `AppError` thrown from the
 * service and reaches the central error handler through Express 5's async support (503
 * UPSTREAM_UNAVAILABLE), so there is no per-handler try/catch. No `getUserId` scoping: ECB
 * reference rates are public data, and the per-user rate limit already sits on the router.
 */

export async function rates(req: Request, res: Response): Promise<void> {
  const query = getValidatedQuery<RatesQuery>(req);

  sendSuccess(res, 200, await getRates(query));
}

export async function convert(req: Request, res: Response): Promise<void> {
  const query = getValidatedQuery<ConvertQuery>(req);

  sendSuccess(res, 200, await convertCurrency(query));
}
