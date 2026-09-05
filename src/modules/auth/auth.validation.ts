import { z } from 'zod';

import { NAME_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../config/constants.js';

/** Request schemas for `/auth` (ARCHITECTURE.md §7 shared validation rules). */

const EMAIL_MAX = 254;
/** bcrypt only reads the first 72 bytes; a cap also keeps hashing cost bounded (R-A1). */
const PASSWORD_MAX = 72;

/** Emails are trimmed and lowercased before validation so `User.email` stays canonical. */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('must be a valid email address').max(EMAIL_MAX));

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(NAME_MAX_LENGTH),
  email,
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX),
});

export const loginSchema = z.object({
  email,
  // No length rules here: rejecting a short password would leak nothing but helps nobody.
  password: z.string().min(1, 'is required').max(PASSWORD_MAX),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
