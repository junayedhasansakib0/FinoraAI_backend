import { Router } from 'express';

import { idParamSchema } from '../../lib/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import {
  create,
  list,
  remove,
  update,
} from './budgets.controller.js';
import {
  createBudgetSchema,
  listBudgetsQuerySchema,
  updateBudgetSchema,
} from './budgets.validation.js';

/** `/budgets` routes (ARCHITECTURE.md §7). Every route is private and user-scoped. */
export const budgetsRouter = Router();

budgetsRouter.use(requireAuth);

budgetsRouter.get('/', validateQuery(listBudgetsQuerySchema), list);
budgetsRouter.post('/', validateBody(createBudgetSchema), create);
budgetsRouter.patch(
  '/:id',
  validateParams(idParamSchema),
  validateBody(updateBudgetSchema),
  update,
);
budgetsRouter.delete('/:id', validateParams(idParamSchema), remove);