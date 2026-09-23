import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';
import { getUserId } from '../../middleware/auth.js';
import { getIdParam, getValidatedQuery } from '../../middleware/validate.js';
import {
  createBudget,
  deleteBudget,
  listBudgets,
  updateBudget,
} from './budgets.service.js';
import type {
  CreateBudgetInput,
  ListBudgetsQuery,
  UpdateBudgetInput,
} from './budgets.validation.js';

/**
 * Transport layer for `/budgets`. Rejected promises reach the central error handler through
 * Express 5's built-in async support, so there is no per-handler try/catch.
 */

export async function list(req: Request, res: Response): Promise<void> {
  const query = getValidatedQuery<ListBudgetsQuery>(req);

  sendSuccess(res, 200, { budgets: await listBudgets(getUserId(req), query) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const budget = await createBudget(getUserId(req), req.body as CreateBudgetInput);

  sendSuccess(res, 201, { budget });
}

export async function update(req: Request, res: Response): Promise<void> {
  const budget = await updateBudget(
    getUserId(req),
    getIdParam(req),
    req.body as UpdateBudgetInput,
  );

  sendSuccess(res, 200, { budget });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await deleteBudget(getUserId(req), getIdParam(req));

  res.status(204).end();
}