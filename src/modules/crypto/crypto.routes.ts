import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { externalApiRateLimiter } from '../../middleware/rate-limit.js';
import { validateQuery } from '../../middleware/validate.js';
import { markets, search } from './crypto.controller.js';
import { listMarketsQuerySchema, searchCoinsQuerySchema } from './crypto.validation.js';

/**
 * `/crypto` routes (ARCHITECTURE.md §7). Private and external-backed: `requireAuth` first so the
 * limiter can bucket by user, then the per-user external limiter guards the shared CoinGecko
 * budget (R-B10). Both routes are read-only informational market data (PROJECT_CONTEXT.md §4.7).
 */
export const cryptoRouter = Router();

cryptoRouter.use(requireAuth);
cryptoRouter.use(externalApiRateLimiter);

cryptoRouter.get('/markets', validateQuery(listMarketsQuerySchema), markets);
cryptoRouter.get('/search', validateQuery(searchCoinsQuerySchema), search);
