import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';

import {
  budgetRecommendations,
  chat,
  monthlySummary,
  reportsHistory,
  savingsRecommendations,
  spendingAnalysis,
} from './ai.controller.js';
import {
  chatBodySchema,
  monthlySummaryBodySchema,
  refreshQuerySchema,
  reportsQuerySchema,
} from './ai.validation.js';

/**
 * `/ai` routes (ARCHITECTURE.md §7). Private and user-scoped. There is deliberately no Express
 * rate-limiter here: the AI Service enforces a per-user quota in-process (15/hr + 50/day, R-I6),
 * which is the limit a user meets first and which already answers RATE_LIMITED (429) with a
 * `retryAfter` — a second IP-based limiter would add nothing and would double-count reused reports,
 * which never reach the provider. `?refresh=true` on any POST bypasses the 24h reuse.
 */
export const aiRouter = Router();

aiRouter.use(requireAuth);

aiRouter.post('/spending-analysis', validateQuery(refreshQuerySchema), spendingAnalysis);
aiRouter.post(
  '/monthly-summary',
  validateQuery(refreshQuerySchema),
  validateBody(monthlySummaryBodySchema),
  monthlySummary,
);
aiRouter.post('/savings-recommendations', validateQuery(refreshQuerySchema), savingsRecommendations);
aiRouter.post('/budget-recommendations', validateQuery(refreshQuerySchema), budgetRecommendations);

aiRouter.post('/chat', validateBody(chatBodySchema), chat);

aiRouter.get('/reports', validateQuery(reportsQuerySchema), reportsHistory);
