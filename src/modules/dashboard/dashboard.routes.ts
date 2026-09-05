import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { validateQuery } from '../../middleware/validate.js';
import { analytics, summary } from './dashboard.controller.js';
import { analyticsQuerySchema } from './dashboard.validation.js';

/** `/dashboard` routes (ARCHITECTURE.md §7). Private, read-only and user-scoped. */
export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get('/summary', summary);
dashboardRouter.get('/analytics', validateQuery(analyticsQuerySchema), analytics);
