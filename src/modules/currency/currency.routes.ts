import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { externalApiRateLimiter } from '../../middleware/rate-limit.js';
import { validateQuery } from '../../middleware/validate.js';
import { convert, rates } from './currency.controller.js';
import { convertQuerySchema, ratesQuerySchema } from './currency.validation.js';

/**
 * `/currency` routes (ARCHITECTURE.md §7). Private and external-backed: `requireAuth` first so the
 * limiter can bucket by user, then the per-user external limiter guards the shared Frankfurter
 * budget (R-B10). Both routes are read-only informational reference data (PROJECT_CONTEXT.md §4.6).
 */
export const currencyRouter = Router();

currencyRouter.use(requireAuth);
currencyRouter.use(externalApiRateLimiter);

currencyRouter.get('/rates', validateQuery(ratesQuerySchema), rates);
currencyRouter.get('/convert', validateQuery(convertQuerySchema), convert);
