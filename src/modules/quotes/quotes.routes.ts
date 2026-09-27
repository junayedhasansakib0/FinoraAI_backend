import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { externalApiRateLimiter } from '../../middleware/rate-limit.js';
import { validateParams } from '../../middleware/validate.js';

import { quote } from './quotes.controller.js';
import { categoryParamSchema } from './quotes.validation.js';

/**
 * `/quotes` routes (ARCHITECTURE.md §7). The motivational card sits on Transactions, Budgets and
 * Goals — core pages an unverified account uses — so this router takes `requireAuth` ONLY and
 * deliberately NOT the `/ai` router's `requireVerifiedEmail` gate. Generation is decorative and
 * backed by a shared upstream, so the endpoint is per-user rate-limited like the other
 * external-backed routes (`externalApiRateLimiter`, keyed by the authenticated user, R-B10). The
 * category is validated to the three-section enum before the controller runs (R-V1).
 */
export const quotesRouter = Router();

quotesRouter.use(requireAuth);
quotesRouter.use(externalApiRateLimiter);

quotesRouter.get('/:category', validateParams(categoryParamSchema), quote);
