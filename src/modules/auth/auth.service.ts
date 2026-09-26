import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

import { catalogCategoryRows } from '../../config/categories.js';
import { BCRYPT_COST, VERIFICATION_TOKEN_TTL_MS } from '../../config/constants.js';
import { AppError } from '../../lib/app-error.js';
import type { TokenPair } from '../../lib/auth-cookies.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { isPasswordDerivedFromEmail } from '../../lib/password-policy.js';
import { isUniqueViolation } from '../../lib/prisma-errors.js';
import { prisma } from '../../lib/prisma.js';
import { generateVerificationToken, hashVerificationToken } from '../../lib/verification-token.js';
import { sendVerificationEmail } from '../../services/email.service.js';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
} from './auth.validation.js';

/** All business rules for `/auth` (ARCHITECTURE.md §6). Controllers stay transport-only. */

/**
 * The only user fields that ever leave the server: no hash, no token version, no raw verification
 * token (R-A6). `emailVerified` IS surfaced — the soft gate never blocks login, so the client needs
 * the flag to prompt an unverified user to verify.
 */
const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  currency: true,
  timezone: true,
  emailVerified: true,
  createdAt: true,
} as const;

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  currency: string;
  timezone: string;
  emailVerified: boolean;
  createdAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

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
 * Sends the verification email without ever letting a delivery problem break the caller. A missing
 * Resend config, a provider rejection, a timeout — all are swallowed here (the client already logs
 * the status, never the address or token, R-A4); the account is created and the user can request a
 * fresh link from the "check your email" screen (§13, R-E6).
 */
async function deliverVerificationEmail(to: string, token: string): Promise<void> {
  try {
    await sendVerificationEmail({ to, token });
  } catch {
    logger.warn('verification_email_not_sent');
  }
}

/**
 * Creates the account and its starter categories in one nested write, so a user never exists
 * without a category list. The account starts unverified with a one-time verification token
 * (only its hash is stored), and the verification email is sent best-effort afterwards. Duplicate
 * emails surface as CONFLICT (§7).
 */
export async function registerUser({ name, email, password }: RegisterInput): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const { token, tokenHash } = generateVerificationToken();
  const verificationTokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

  let user: PublicUser;
  try {
    user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        verificationTokenHash: tokenHash,
        verificationTokenExpiresAt,
        categories: { create: catalogCategoryRows() },
      },
      select: PUBLIC_USER_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError('CONFLICT', 'An account with this email already exists.');
    }
    throw error;
  }

  // Best-effort; never fatal (soft gate). Sent after the row exists so a send failure cannot orphan.
  await deliverVerificationEmail(user.email, token);

  // A new account always starts at tokenVersion 0.
  return { user, tokens: issueTokens(user.id, 0) };
}

export type VerifyEmailStatus = 'verified' | 'expired' | 'invalid';

/**
 * Redeems a verification token. Returns a status the client renders directly — never an error for
 * a bad token, so the endpoint is not an oracle. Lookup is by the token's hash (indexed, unique).
 * On success the account is marked verified and the token is cleared, making it strictly one-time
 * use (§4): a reused link no longer matches any row and reads as `invalid`.
 */
export async function verifyEmail(token: string): Promise<{ status: VerifyEmailStatus }> {
  const tokenHash = hashVerificationToken(token);

  const user = await prisma.user.findUnique({
    where: { verificationTokenHash: tokenHash },
    select: { id: true, emailVerified: true, verificationTokenExpiresAt: true },
  });

  if (!user) {
    return { status: 'invalid' };
  }

  if (user.emailVerified) {
    return { status: 'verified' };
  }

  if (
    user.verificationTokenExpiresAt === null ||
    user.verificationTokenExpiresAt.getTime() < Date.now()
  ) {
    return { status: 'expired' };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      emailVerifiedAt: new Date(),
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
    },
  });

  return { status: 'verified' };
}

/**
 * Issues a fresh verification link for an unverified account. Does nothing (silently) for an
 * unknown or already-verified email: the controller returns an identical generic response either
 * way, so this never reveals whether an address is registered (anti-enumeration, R-A7). A new token
 * replaces any previous one, so older links stop working.
 */
export async function resendVerification(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, emailVerified: true },
  });

  if (!user || user.emailVerified) {
    return;
  }

  const { token, tokenHash } = generateVerificationToken();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationTokenHash: tokenHash,
      verificationTokenExpiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
    },
  });

  await deliverVerificationEmail(user.email, token);
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

/**
 * Updates the editable profile fields (§7). Only the keys present in `input` are written; Prisma
 * ignores `undefined`, so an omitted field is left untouched. No field here is unique, so there is
 * no conflict to map.
 */
export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<PublicUser> {
  return prisma.user.update({
    where: { id: userId },
    data: input,
    select: PUBLIC_USER_SELECT,
  });
}

/**
 * Changes the password after re-verifying the current one, then bumps `tokenVersion` so every
 * refresh token already issued (on other devices) stops verifying (R-A2). Fresh cookies are
 * re-issued for the caller so the session they are changing the password from stays alive.
 */
export async function changePassword(
  userId: string,
  { currentPassword, newPassword }: ChangePasswordInput,
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, passwordHash: true },
  });

  if (!user) {
    throw new AppError('UNAUTHENTICATED', 'Your session is no longer valid.');
  }

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AppError('INVALID_CREDENTIALS', 'Your current password is incorrect.');
  }

  // Same email-similarity rule as registration (§8): the new password must not be the email dressed
  // up. Complexity rules are already enforced by the schema before this runs (R-V1).
  if (isPasswordDerivedFromEmail(user.email, newPassword)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Your password must not be based on your email address.',
    );
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, tokenVersion: { increment: 1 } },
    select: { ...PUBLIC_USER_SELECT, tokenVersion: true },
  });

  const { tokenVersion, ...publicUser } = updated;

  return { user: publicUser, tokens: issueTokens(updated.id, tokenVersion) };
}
