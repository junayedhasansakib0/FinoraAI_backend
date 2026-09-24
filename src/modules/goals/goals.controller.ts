import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';
import { getUserId } from '../../middleware/auth.js';
import { getIdParam } from '../../middleware/validate.js';
import {
  createSavingsGoal,
  deleteSavingsGoal,
  listSavingsGoals,
  updateSavingsGoal,
} from './goals.service.js';
import type {
  CreateSavingsGoalInput,
  UpdateSavingsGoalInput,
} from './goals.validation.js';

/**
 * Transport layer for `/savings-goals`. Rejected promises reach the central error handler through
 * Express 5's built-in async support, so there is no per-handler try/catch.
 */

export async function list(req: Request, res: Response): Promise<void> {
  sendSuccess(res, 200, { goals: await listSavingsGoals(getUserId(req)) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const goal = await createSavingsGoal(getUserId(req), req.body as CreateSavingsGoalInput);

  sendSuccess(res, 201, { goal });
}

export async function update(req: Request, res: Response): Promise<void> {
  const goal = await updateSavingsGoal(
    getUserId(req),
    getIdParam(req),
    req.body as UpdateSavingsGoalInput,
  );

  sendSuccess(res, 200, { goal });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await deleteSavingsGoal(getUserId(req), getIdParam(req));

  res.status(204).end();
}
