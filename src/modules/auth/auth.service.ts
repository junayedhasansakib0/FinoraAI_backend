import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

import { catalogCategoryRows } from '../../config/categories.js';
import { BCRYPT_COST } from '../../config/constants.js';
import { AppError } from '../../lib/app-error.js';
import type { TokenPair } from '../../lib/auth-cookies.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/jwt.js';
import { prisma } from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { LoginInput, RegisterInput } from './auth.validation.js';

/** All business rules for `/auth` (ARCHITECTURE.md §6). Controllers stay transport-only. */

/** The only user fields that ever leave the server: no hash, no token version (R-A6). */
const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  currency: true,
  timezone: true,
  createdAt: true,
} as const;

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  currency: string;
  timezone: string;
  createdAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

const UNIQUE_VIOLATION = 'P2002';

function issueTokens(userId: string, tokenVersion: number): TokenPair {
  return {
    accessToken: signAccessToken(userId),
    refreshToken: signRefreshToken(userId, tokenVersion),
  };
}

/**
 * Hashing a throwaway value costs the same as hashing a real one, so an unknown email takes
 * as long to reject as a wrong password. Without this, response time reveals which emails
 * are registered (R-A7).
 */
let decoyHash: string | undefined;

async function burnPasswordComparison(password: string): Promise<void> {
  decoyHash ??= await bcrypt.hash(randomUUID(), BCRYPT_COST);
  await bcrypt.compare(password, decoyHash);
}

/**
 * Creates the account and its starter categories in one nested write, so a user never exists
 * without a category list. Duplicate emails surface as CONFLICT (§7).
 */
export async function registerUser({ name, email, password }: RegisterInput): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        categories: { create: catalogCategoryRows() },
      },
      select: PUBLIC_USER_SELECT,
    });

    // A new account always starts at tokenVersion 0.
    return { user, tokens: issueTokens(user.id, 0) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
      throw new AppError('CONFLICT', 'An account with this email already exists.');
    }
    throw error;
  }
}

export async function loginUser({ email, password }: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { ...PUBLIC_USER_SELECT, passwordHash: true, tokenVersion: true },
  });

  if (!user) {
    await burnPasswordComparison(password);
    throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  const { passwordHash: _passwordHash, tokenVersion, ...publicUser } = user;

  return { user: publicUser, tokens: issueTokens(user.id, tokenVersion) };
}

/**
 * Rotates both cookies. The token's `tokenVersion` must still match the stored one, so a
 * password change (which bumps it) invalidates every refresh token already in the wild.
 */
export async function refreshSession(refreshToken: string): Promise<AuthResult> {
  const payload = verifyRefreshToken(refreshToken);

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { ...PUBLIC_USER_SELECT, tokenVersion: true },
  });

  if (!user || user.tokenVersion !== payload.tokenVersion) {
    throw new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  }

  const { tokenVersion, ...publicUser } = user;

  return { user: publicUser, tokens: issueTokens(user.id, tokenVersion) };
}

export async function getUserById(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: PUBLIC_USER_SELECT,
  });

  if (!user) {
    // The token was valid but the account is gone.
    throw new AppError('UNAUTHENTICATED', 'Your session is no longer valid.');
  }

  return user;
}
