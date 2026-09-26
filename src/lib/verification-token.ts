import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { VERIFICATION_TOKEN_BYTES } from '../config/constants.js';

/**
 * Email-verification token helper (soft-gate phase). The token that travels in the verification
 * link is high-entropy random bytes; only its SHA-256 hash is ever persisted, so a database leak
 * never exposes a usable link (the same reasoning as never storing a raw password). The plaintext
 * token exists only in the email and in the request that redeems it — it is NEVER logged (R-A4).
 *
 * SHA-256 (not bcrypt) is deliberate: the token is already 256 bits of entropy, so it is not
 * brute-forceable and needs no slow KDF; a fast digest keeps the redeem lookup cheap while the
 * unique index on the hash column stays effective.
 */

/** A fresh token plus the hash to store. Return the token to the caller; persist only the hash. */
export function generateVerificationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(VERIFICATION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashVerificationToken(token) };
}

/** Deterministic hash of a token, matching what `generateVerificationToken` stored. */
export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two token hashes. Lookups go through the unique index on the hash
 * column, so this is a defence-in-depth helper for callers that compare a stored hash directly.
 */
export function verificationHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
