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
  resendVerification as resendVerificationService,
  updateProfile as updateProfileService,
  verifyEmail as verifyEmailService,
  type AuthResult,
} from './auth.service.js';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResendVerificationInput,
  UpdateProfileInput,
  VerifyEmailInput,
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

/**
 * Redeems a verification token. Always answers 200 with a `status` the client renders — never an
 * error for a bad token, so the endpoint reveals nothing and is not an oracle (§5).
 */
export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const { token } = req.body as VerifyEmailInput;
  sendSuccess(res, 200, await verifyEmailService(token));
}

/**
 * Requests a fresh verification email. The response is identical whether or not the address is a
 * known, unverified account (anti-enumeration, §5/R-A7); the work happens only when it applies.
 */
export async function resendVerification(req: Request, res: Response): Promise<void> {
  const { email } = req.body as ResendVerificationInput;
  await resendVerificationService(email);
  sendSuccess(res, 200, {
    message: 'If that email needs verification, a new link is on its way.',
  });
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
