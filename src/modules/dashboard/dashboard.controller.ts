import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';
import { getUserId } from '../../middleware/auth.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import { readAnalytics, readSummary } from './dashboard.service.js';
import type { AnalyticsQuery } from './dashboard.validation.js';

/**
 * Transport layer for `/dashboard`. Both routes are read-only and return the whole computed
 * view as `data`, since neither one is a collection with an envelope of its own (§4).
 */

export async function summary(req: Request, res: Response): Promise<void> {
  sendSuccess(res, 200, await readSummary(getUserId(req)));
}

export async function analytics(req: Request, res: Response): Promise<void> {
  const { months } = getValidatedQuery<AnalyticsQuery>(req);

  sendSuccess(res, 200, await readAnalytics(getUserId(req), months));
}
