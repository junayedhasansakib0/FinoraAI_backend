import { z } from 'zod';

import { NAME_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../config/constants.js';
import { resolveTimeZone } from '../../lib/month-range.js';

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

const name = z.string().trim().min(1, 'is required').max(NAME_MAX_LENGTH);

/** ISO-4217 base currency: three letters, upper-cased so it matches how `User.currency` is stored. */
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO-4217 code'));

/** A profile timezone must be one the runtime's tz database knows (D9); UTC is always valid. */
const timezone = z
  .string()
  .trim()
  .refine((value) => resolveTimeZone(value) === value, 'must be a valid IANA timezone');

export const registerSchema = z.object({
  name,
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

/** Profile edit (§7): any subset of the editable fields, but at least one must be present. */
export const updateProfileSchema = z
  .object({
    name: name.optional(),
    currency: currency.optional(),
    timezone: timezone.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'at least one field is required',
  });

/**
 * Password change (§7): the current password is re-verified before the new one is set, and the
 * new one obeys the same floor as registration. Both are capped at bcrypt's 72-byte read (R-A1).
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'is required').max(PASSWORD_MAX),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
