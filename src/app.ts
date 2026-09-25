import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { API_BASE_PATH, HEALTH_PATH, JSON_BODY_LIMIT } from './config/constants.js';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { globalRateLimiter } from './middleware/rate-limit.js';
import { requestLogger } from './middleware/request-logger.js';
import { aiRouter } from './modules/ai/ai.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { budgetsRouter } from './modules/budgets/budgets.routes.js';
import { categoriesRouter } from './modules/categories/categories.routes.js';
import { cryptoRouter } from './modules/crypto/crypto.routes.js';
import { currencyRouter } from './modules/currency/currency.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { savingsGoalsRouter } from './modules/goals/goals.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { transactionsRouter } from './modules/transactions/transactions.routes.js';

/**
 * Builds the Express application: middleware chain, routes, error handling
 * (ARCHITECTURE.md §4). Exported as a factory so tests can drive it with Supertest
 * without opening a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by'); // R-A8

  // In production the API runs behind the host's reverse proxy (e.g. Render). Trust the first hop
  // so Express reads the client's real IP and protocol from the `X-Forwarded-*` headers: the per-IP
  // rate limiter then buckets by the real client rather than the proxy, and `Secure` cookies are set
  // over the proxy's TLS. Never trusted in development or test, where there is no proxy (R-A5).
  if (env.isProduction) {
    app.set('trust proxy', 1);
  }

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
  app.use(`${API_BASE_PATH}/categories`, categoriesRouter);
  app.use(`${API_BASE_PATH}/transactions`, transactionsRouter);
  app.use(`${API_BASE_PATH}/dashboard`, dashboardRouter);
  app.use(`${API_BASE_PATH}/budgets`, budgetsRouter);
  app.use(`${API_BASE_PATH}/savings-goals`, savingsGoalsRouter);
  app.use(`${API_BASE_PATH}/currency`, currencyRouter);
  app.use(`${API_BASE_PATH}/crypto`, cryptoRouter);
  app.use(`${API_BASE_PATH}/ai`, aiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
