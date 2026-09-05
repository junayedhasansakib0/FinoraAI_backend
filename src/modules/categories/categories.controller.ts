import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';
import { getUserId } from '../../middleware/auth.js';
import { getIdParam, getValidatedQuery } from '../../middleware/validate.js';
import {
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
} from './categories.service.js';
import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  UpdateCategoryInput,
} from './categories.validation.js';

/**
 * Transport layer for `/categories`. Rejected promises reach the central error handler through
 * Express 5's built-in async support, so there is no per-handler try/catch.
 */

export async function list(req: Request, res: Response): Promise<void> {
  const query = getValidatedQuery<ListCategoriesQuery>(req);

  sendSuccess(res, 200, { categories: await listCategories(getUserId(req), query) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const category = await createCategory(getUserId(req), req.body as CreateCategoryInput);

  sendSuccess(res, 201, { category });
}

export async function rename(req: Request, res: Response): Promise<void> {
  const category = await renameCategory(
    getUserId(req),
    getIdParam(req),
    req.body as UpdateCategoryInput,
  );

  sendSuccess(res, 200, { category });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await deleteCategory(getUserId(req), getIdParam(req));

  res.status(204).end();
}
