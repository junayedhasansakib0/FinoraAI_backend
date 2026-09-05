import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { API_BASE_PATH, HEALTH_PATH, JSON_BODY_LIMIT } from './config/constants.js';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { globalRateLimiter } from './middleware/rate-limit.js';
import { requestLogger } from './middleware/request-logger.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { healthRouter } from './modules/health/health.routes.js';

/**
 * Builds the Express application: middleware chain, routes, error handling
 * (ARCHITECTURE.md §4). Exported as a factory so tests can drive it with Supertest
 * without opening a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by'); // R-A8

  app.use(helmet());
  // Exact origin allowlist with credentials — never a wildcard (R-A5).
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(requestLogger);
  app.use(globalRateLimiter);

  // Root path for host uptime checks, versioned path for the SPA.
  app.use(HEALTH_PATH, healthRouter);
  app.use(`${API_BASE_PATH}${HEALTH_PATH}`, healthRouter);

  app.use(`${API_BASE_PATH}/auth`, authRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
