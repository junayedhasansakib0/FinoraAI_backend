import { Router } from 'express';

import { getHealth } from './health.controller.js';

/** Public route — no auth guard (ARCHITECTURE.md §7). */
export const healthRouter = Router();

healthRouter.get('/', getHealth);
