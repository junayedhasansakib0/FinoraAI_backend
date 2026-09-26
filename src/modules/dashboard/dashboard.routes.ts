import { Router } from 'express';

import { requireAuth, requireVerifiedEmail } from '../../middleware/auth.js';
import { validateQuery } from '../../middleware/validate.js';
import { analytics, summary } from './dashboard.controller.js';
import { analyticsQuerySchema } from './dashboard.validation.js';

/** `/dashboard` routes (ARCHITECTURE.md §7). Private, read-only and user-scoped. */
export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

// `/summary` is the basic account overview and stays open to unverified accounts. `/analytics`
// (trends + breakdown) is the gated "insights" surface, so it also requires a verified email.
dashboardRouter.get('/summary', summary);
dashboardRouter.get('/analytics', requireVerifiedEmail, validateQuery(analyticsQuerySchema), analytics);
