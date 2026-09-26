import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { authRateLimiter, resendVerificationRateLimiter } from '../../middleware/rate-limit.js';
import { validateBody } from '../../middleware/validate.js';
import {
  changePassword,
  login,
  logout,
  me,
  refresh,
  register,
  resendVerification,
  updateProfile,
  verifyEmail,
} from './auth.controller.js';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from './auth.validation.js';

/**
 * `/auth` routes (ARCHITECTURE.md §7). Register, login, refresh, verify-email, and
 * resend-verification are public but rate-limited; logout, me, profile edit, and password change
 * require a valid access cookie. The password change also carries the credential rate limit — it
 * verifies a password, so it must not be a brute-force oracle. Verify-email shares the credential
 * limiter; resend-verification has its own tighter budget (it sends a metered email).
 */
export const authRouter = Router();

authRouter.post('/register', authRateLimiter, validateBody(registerSchema), register);
authRouter.post('/login', authRateLimiter, validateBody(loginSchema), login);
authRouter.post('/refresh', authRateLimiter, refresh);
authRouter.post('/verify-email', authRateLimiter, validateBody(verifyEmailSchema), verifyEmail);
authRouter.post(
  '/resend-verification',
  resendVerificationRateLimiter,
  validateBody(resendVerificationSchema),
  resendVerification,
);
authRouter.post('/logout', requireAuth, logout);
authRouter.get('/me', requireAuth, me);
authRouter.patch('/profile', requireAuth, validateBody(updateProfileSchema), updateProfile);
authRouter.post(
  '/change-password',
  authRateLimiter,
  requireAuth,
  validateBody(changePasswordSchema),
  changePassword,
);
