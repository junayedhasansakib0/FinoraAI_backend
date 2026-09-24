import { Router } from 'express';

import { idParamSchema } from '../../lib/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import {
  create,
  list,
  remove,
  update,
} from './goals.controller.js';
import {
  createSavingsGoalSchema,
  updateSavingsGoalSchema,
} from './goals.validation.js';

/** `/savings-goals` routes (ARCHITECTURE.md §7). Every route is private and user-scoped. */
export const savingsGoalsRouter = Router();

savingsGoalsRouter.use(requireAuth);

savingsGoalsRouter.get('/', list);
savingsGoalsRouter.post('/', validateBody(createSavingsGoalSchema), create);
savingsGoalsRouter.patch(
  '/:id',
  validateParams(idParamSchema),
  validateBody(updateSavingsGoalSchema),
  update,
);
savingsGoalsRouter.delete('/:id', validateParams(idParamSchema), remove);
