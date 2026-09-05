import { Router } from 'express';

import { idParamSchema } from '../../lib/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { create, list, remove, rename } from './categories.controller.js';
import {
  createCategorySchema,
  listCategoriesQuerySchema,
  updateCategorySchema,
} from './categories.validation.js';

/** `/categories` routes (ARCHITECTURE.md §7). Every route is private and user-scoped. */
export const categoriesRouter = Router();

categoriesRouter.use(requireAuth);

categoriesRouter.get('/', validateQuery(listCategoriesQuerySchema), list);
categoriesRouter.post('/', validateBody(createCategorySchema), create);
categoriesRouter.patch(
  '/:id',
  validateParams(idParamSchema),
  validateBody(updateCategorySchema),
  rename,
);
categoriesRouter.delete('/:id', validateParams(idParamSchema), remove);
