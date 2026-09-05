import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';
import { getUserId } from '../../middleware/auth.js';
import { getIdParam, getValidatedQuery } from '../../middleware/validate.js';
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from './transactions.service.js';
import type {
  CreateTransactionInput,
  ListTransactionsQuery,
  UpdateTransactionInput,
} from './transactions.validation.js';

/**
 * Transport layer for `/transactions`. Rejected promises reach the central error handler through
 * Express 5's built-in async support, so there is no per-handler try/catch.
 */

/** The list is the paginated envelope from §4, so the page object is the whole `data`. */
export async function list(req: Request, res: Response): Promise<void> {
  const query = getValidatedQuery<ListTransactionsQuery>(req);

  sendSuccess(res, 200, await listTransactions(getUserId(req), query));
}

export async function create(req: Request, res: Response): Promise<void> {
  const transaction = await createTransaction(getUserId(req), req.body as CreateTransactionInput);

  sendSuccess(res, 201, { transaction });
}

export async function detail(req: Request, res: Response): Promise<void> {
  const transaction = await getTransaction(getUserId(req), getIdParam(req));

  sendSuccess(res, 200, { transaction });
}

export async function update(req: Request, res: Response): Promise<void> {
  const transaction = await updateTransaction(
    getUserId(req),
    getIdParam(req),
    req.body as UpdateTransactionInput,
  );

  sendSuccess(res, 200, { transaction });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await deleteTransaction(getUserId(req), getIdParam(req));

  res.status(204).end();
}
