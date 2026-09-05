/**
 * `requireAuth` attaches the caller's id to the request, so every downstream handler can
 * scope its queries to one user (R-A5).
 */

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
