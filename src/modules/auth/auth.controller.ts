import type { Request, Response } from 'express';

import { AUTH_COOKIES } from '../../config/constants.js';
import { sendSuccess } from '../../lib/api-response.js';
import { AppError } from '../../lib/app-error.js';
import { clearAuthCookies, setAuthCookies } from '../../lib/auth-cookies.js';
import { getUserId } from '../../middleware/auth.js';
import {
  getUserById,
  loginUser,
  refreshSession,
  registerUser,
  type AuthResult,
} from './auth.service.js';
import type { LoginInput, RegisterInput } from './auth.validation.js';

/**
 * Transport layer for `/auth`. Rejected promises reach the central error handler through
 * Express 5's built-in async support, so there is no per-handler try/catch.
 */

/** Tokens go out as cookies only; the body carries the user (R-A3). */
function respondWithSession(res: Response, status: number, { user, tokens }: AuthResult): void {
  setAuthCookies(res, tokens);
  sendSuccess(res, status, { user });
}

export async function register(req: Request, res: Response): Promise<void> {
  respondWithSession(res, 201, await registerUser(req.body as RegisterInput));
}

export async function login(req: Request, res: Response): Promise<void> {
  respondWithSession(res, 200, await loginUser(req.body as LoginInput));
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token: unknown = req.cookies?.[AUTH_COOKIES.refresh.name];

  if (typeof token !== 'string' || token.length === 0) {
    throw new AppError('UNAUTHENTICATED', 'No active session.');
  }

  respondWithSession(res, 200, await refreshSession(token));
}

export function logout(_req: Request, res: Response): void {
  clearAuthCookies(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  sendSuccess(res, 200, { user: await getUserById(getUserId(req)) });
}
