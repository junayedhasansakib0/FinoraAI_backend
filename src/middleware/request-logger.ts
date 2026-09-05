import type { NextFunction, Request, Response } from 'express';

import { logger } from '../lib/logger.js';

/**
 * Access log (R-L1): method, path, status, duration. Query strings and bodies are never
 * logged because they can carry financial data.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  // originalUrl keeps the full path across mounted routers; the query string is dropped.
  const path = req.originalUrl.split('?')[0] ?? req.path;

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    logger.info('request_completed', {
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
}
