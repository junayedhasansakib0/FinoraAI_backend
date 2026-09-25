import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { authRateLimiter } from '../../middleware/rate-limit.js';
import { validateBody } from '../../middleware/validate.js';
import {
  changePassword,
  login,
  logout,
  me,
  refresh,
  register,
  updateProfile,
} from './auth.controller.js';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from './auth.validation.js';

/**
 * `/auth` routes (ARCHITECTURE.md §7). Register, login, and refresh are public but share the
 * tightened credential rate limit; logout, me, profile edit, and password change require a valid
 * access cookie. The password change also carries the credential rate limit — it verifies a
 * password, so it must not be a brute-force oracle.
 */
export const authRouter = Router();

authRouter.post('/register', authRateLimiter, validateBody(registerSchema), register);
authRouter.post('/login', authRateLimiter, validateBody(loginSchema), login);
authRouter.post('/refresh', authRateLimiter, refresh);
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
