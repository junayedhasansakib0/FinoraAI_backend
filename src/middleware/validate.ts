import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

/**
 * Routes validate before they reach a controller (R-B1). The parsed value replaces the raw
 * body, so handlers only ever see trimmed, coerced, schema-shaped data. Failures are handed
 * to the error handler, which renders a `VALIDATION_ERROR` with per-field details.
 */
export function validateBody<TOutput>(schema: ZodType<TOutput>) {
  return function validate(req: Request, _res: Response, next: NextFunction): void {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(result.error);
      return;
    }

    req.body = result.data;
    next();
  };
}
