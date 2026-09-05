import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { authRateLimiter } from '../../middleware/rate-limit.js';
import { validateBody } from '../../middleware/validate.js';
import { login, logout, me, refresh, register } from './auth.controller.js';
import { loginSchema, registerSchema } from './auth.validation.js';

/**
 * `/auth` routes (ARCHITECTURE.md §7). Register, login, and refresh are public but share the
 * tightened credential rate limit; logout and me require a valid access cookie.
 */
export const authRouter = Router();

authRouter.post('/register', authRateLimiter, validateBody(registerSchema), register);
authRouter.post('/login', authRateLimiter, validateBody(loginSchema), login);
authRouter.post('/refresh', authRateLimiter, refresh);
authRouter.post('/logout', requireAuth, logout);
authRouter.get('/me', requireAuth, me);
