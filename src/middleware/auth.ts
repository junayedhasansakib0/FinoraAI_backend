import type { NextFunction, Request, Response } from 'express';

import { AUTH_COOKIES } from '../config/constants.js';
import { AppError } from '../lib/app-error.js';
import { verifyAccessToken } from '../lib/jwt.js';

/**
 * Gate for every non-public route (ARCHITECTURE.md §6). It only reads the access cookie —
 * no database round trip — and answers 401 so the client can attempt a silent refresh.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token: unknown = req.cookies?.[AUTH_COOKIES.access.name];

  if (typeof token !== 'string' || token.length === 0) {
    next(new AppError('UNAUTHENTICATED', 'Authentication required.'));
    return;
  }

  try {
    req.userId = verifyAccessToken(token).userId;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Reads the id that `requireAuth` attached. Throwing here would mean a protected route was
 * mounted without the middleware, so it fails closed rather than querying for `undefined`.
 */
export function getUserId(req: Request): string {
  if (req.userId === undefined) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required.');
  }
  return req.userId;
}
