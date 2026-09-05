import { Router } from 'express';

import { idParamSchema } from '../../lib/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { create, detail, list, remove, update } from './transactions.controller.js';
import {
  createTransactionSchema,
  listTransactionsQuerySchema,
  updateTransactionSchema,
} from './transactions.validation.js';

/** `/transactions` routes (ARCHITECTURE.md §7). Every route is private and user-scoped. */
export const transactionsRouter = Router();

transactionsRouter.use(requireAuth);

transactionsRouter.get('/', validateQuery(listTransactionsQuerySchema), list);
transactionsRouter.post('/', validateBody(createTransactionSchema), create);
transactionsRouter.get('/:id', validateParams(idParamSchema), detail);
transactionsRouter.patch(
  '/:id',
  validateParams(idParamSchema),
  validateBody(updateTransactionSchema),
  update,
);
transactionsRouter.delete('/:id', validateParams(idParamSchema), remove);
