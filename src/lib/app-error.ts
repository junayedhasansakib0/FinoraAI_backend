/** Error code to HTTP status mapping (ARCHITECTURE.md §4). */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  // The request was well-formed but there is not enough of the user's own data to act on
  // (an AI report asked for before any transactions exist, ARCHITECTURE.md §7 AI).
  NO_DATA: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 503,
  AI_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * Expected, business-level failures (R-B7). Anything thrown that is not an AppError is
 * treated as unexpected and answered with a generic INTERNAL error.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}
