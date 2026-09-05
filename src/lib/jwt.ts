import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '../config/constants.js';
import { env } from '../config/env.js';
import { AppError } from './app-error.js';

/**
 * Token signing and verification (ARCHITECTURE.md §6). Access and refresh tokens are signed
 * with different secrets, so a token issued for one purpose can never be replayed as the
 * other. Payloads are re-validated after verification: a decoded JWT is untrusted input
 * until its shape has been checked.
 */

const ISSUER = 'finora-ai';

const accessPayloadSchema = z.object({ sub: z.string().min(1) });

const refreshPayloadSchema = z.object({
  sub: z.string().min(1),
  tokenVersion: z.number().int().nonnegative(),
});

export interface AccessTokenPayload {
  userId: string;
}

export interface RefreshTokenPayload {
  userId: string;
  tokenVersion: number;
}

export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, {
    subject: userId,
    issuer: ISSUER,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function signRefreshToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ tokenVersion }, env.JWT_REFRESH_SECRET, {
    subject: userId,
    issuer: ISSUER,
    expiresIn: REFRESH_TOKEN_TTL_SECONDS,
  });
}

/** Every verification failure — expired, tampered, wrong secret — looks the same (R-A7). */
function decode(token: string, secret: string): unknown {
  try {
    return jwt.verify(token, secret, { issuer: ISSUER });
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Your session is not valid. Please sign in again.');
  }
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const parsed = accessPayloadSchema.safeParse(decode(token, env.JWT_ACCESS_SECRET));
  if (!parsed.success) {
    throw new AppError('UNAUTHENTICATED', 'Your session is not valid. Please sign in again.');
  }
  return { userId: parsed.data.sub };
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const parsed = refreshPayloadSchema.safeParse(decode(token, env.JWT_REFRESH_SECRET));
  if (!parsed.success) {
    throw new AppError('UNAUTHENTICATED', 'Your session is not valid. Please sign in again.');
  }
  return { userId: parsed.data.sub, tokenVersion: parsed.data.tokenVersion };
}
