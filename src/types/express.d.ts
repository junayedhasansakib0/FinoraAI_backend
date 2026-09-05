/**
 * `requireAuth` attaches the caller's id to the request, so every downstream handler can
 * scope its queries to one user (R-A5). `validateQuery` attaches the coerced query string,
 * which Express 5 will not let middleware replace in place.
 */

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      validatedQuery?: unknown;
    }
  }
}

export {};
