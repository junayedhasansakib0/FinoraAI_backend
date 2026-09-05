import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { AppError } from '../lib/app-error.js';
import { sendError } from '../lib/api-response.js';
import { logger } from '../lib/logger.js';

/** Body-parser failures carry a `type` discriminator. */
interface ParserError {
  type?: string;
}

function parserErrorType(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'type' in error) {
    const { type } = error as ParserError;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

function fieldDetails(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
}

/** Unmatched routes answer 404 without revealing whether anything exists (R-A7). */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError('NOT_FOUND', 'Resource not found.'));
}

/**
 * Central error handler (R-B6/R-B7/R-B9): expected failures keep their code and message,
 * everything else is logged server-side and answered with a generic INTERNAL error.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    return;
  }

  if (error instanceof AppError) {
    sendError(res, error.code, error.message, error.details);
    return;
  }

  if (error instanceof ZodError) {
    sendError(res, 'VALIDATION_ERROR', 'Request validation failed.', fieldDetails(error));
    return;
  }

  switch (parserErrorType(error)) {
    case 'entity.parse.failed':
      sendError(res, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
      return;
    case 'entity.too.large':
      sendError(res, 'VALIDATION_ERROR', 'Request body is too large.');
      return;
    default:
      break;
  }

  logger.error('unhandled_error', {
    name: error instanceof Error ? error.name : 'UnknownError',
    reason: error instanceof Error ? error.message : 'non-error value thrown',
    stack: error instanceof Error ? error.stack : undefined,
  });

  sendError(res, 'INTERNAL', 'Something went wrong. Please try again.');
}
