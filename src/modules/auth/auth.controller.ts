import type { Request, Response } from 'express';

import { AUTH_COOKIES } from '../../config/constants.js';
import { sendSuccess } from '../../lib/api-response.js';
import { AppError } from '../../lib/app-error.js';
import { clearAuthCookies, setAuthCookies } from '../../lib/auth-cookies.js';
import { getUserId } from '../../middleware/auth.js';
import {
  changePassword as changePasswordService,
  getUserById,
  loginUser,
  refreshSession,
  registerUser,
  updateProfile as updateProfileService,
  type AuthResult,
} from './auth.service.js';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
} from './auth.validation.js';

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

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const user = await updateProfileService(getUserId(req), req.body as UpdateProfileInput);
  sendSuccess(res, 200, { user });
}

/** Re-issues cookies so the caller stays signed in even though the version bump killed the old ones. */
export async function changePassword(req: Request, res: Response): Promise<void> {
  respondWithSession(res, 200, await changePasswordService(getUserId(req), req.body as ChangePasswordInput));
}
