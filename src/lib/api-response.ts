import type { Response } from 'express';

import { ERROR_STATUS, type ErrorCode } from './app-error.js';

/**
 * The single response envelope used by every endpoint (ARCHITECTURE.md §4, R-B8).
 */

export interface SuccessBody<TData> {
  success: true;
  data: TData;
}

export interface ErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export function sendSuccess<TData>(res: Response, status: number, data: TData): void {
  res.status(status).json({ success: true, data } satisfies SuccessBody<TData>);
}

/** Status is derived from the error code so the documented mapping cannot drift. */
export function sendError(
  res: Response,
  code: ErrorCode,
  message: string,
  details?: unknown,
): void {
  const error: ErrorBody['error'] = { code, message };
  if (details !== undefined) {
    error.details = details;
  }

  res.status(ERROR_STATUS[code]).json({ success: false, error } satisfies ErrorBody);
}
