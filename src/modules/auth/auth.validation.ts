import { z } from 'zod';

import { NAME_MAX_LENGTH } from '../../config/constants.js';
import { isDisposableEmail } from '../../lib/disposable-email.js';
import { resolveTimeZone } from '../../lib/month-range.js';
import { isPasswordDerivedFromEmail, unmetPasswordRules } from '../../lib/password-policy.js';

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

/**
 * Registration email adds disposable-provider rejection on top of the base rules. The message is
 * deliberately generic and the blocklist is never surfaced (R-A4-adjacent). Login keeps the plain
 * `email` so the soft gate stays non-breaking for any address already registered.
 */
const registrationEmail = email.refine(
  (value) => !isDisposableEmail(value),
  'Please use a permanent email address.',
);

const name = z.string().trim().min(1, 'is required').max(NAME_MAX_LENGTH);

/**
 * Password strength (ARCHITECTURE.md §6): 8+ characters with a lowercase, an uppercase, a number
 * and a special character. All unmet rules are reported in one message so the frontend checklist
 * and the backend agree on the wording. The 72-byte cap matches bcrypt's read window (R-A1). The
 * server is the authority — the client's live meter is only a hint (R-V1).
 */
const password = z
  .string()
  .max(PASSWORD_MAX)
  .superRefine((value, ctx) => {
    const unmet = unmetPasswordRules(value);
    if (unmet.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `must have ${unmet.map((rule) => rule.label).join(', ')}`,
      });
    }
  });

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

export const registerSchema = z
  .object({
    name,
    email: registrationEmail,
    password,
  })
  .superRefine((value, ctx) => {
    // The password must not simply be the email dressed up (§8). Checked at the object level so
    // both fields are available; the issue is attached to the password field.
    if (isPasswordDerivedFromEmail(value.email, value.password)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'must not be based on your email address',
      });
    }
  });

export const loginSchema = z.object({
  email,
  // No length rules here: rejecting a short password would leak nothing but helps nobody.
  password: z.string().min(1, 'is required').max(PASSWORD_MAX),
});

/** Verification token redemption (§5): a non-empty opaque token, capped so it cannot run away. */
export const verifyEmailSchema = z.object({
  token: z.string().trim().min(1, 'is required').max(512),
});

/** Resend a verification email (§5). Uses the base email rules; the response is always generic. */
export const resendVerificationSchema = z.object({
  email,
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
 * Password change (§7): the current password is re-verified before the new one is set, and the new
 * one obeys the same strength policy as registration (§8). Both are capped at bcrypt's 72-byte read
 * (R-A1). The email-similarity check happens in the service, which has the account's email.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'is required').max(PASSWORD_MAX),
  newPassword: password,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
