import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

/**
 * Routes validate before they reach a controller (R-B1), and every external input goes through
 * a schema (R-V1). Failures are handed to the error handler, which renders a
 * `VALIDATION_ERROR` with per-field details (R-V6).
 */

export function validateBody<TOutput>(schema: ZodType<TOutput>) {
  /** The parsed value replaces the raw body, so handlers only see schema-shaped data. */
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

/**
 * Express 5 exposes `req.query` through a getter with no setter, so the coerced value is
 * attached as `req.validatedQuery` instead of replacing it. Read it with `getValidatedQuery`.
 */
export function validateQuery<TOutput>(schema: ZodType<TOutput>) {
  return function validate(req: Request, _res: Response, next: NextFunction): void {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      next(result.error);
      return;
    }

    req.validatedQuery = result.data;
    next();
  };
}

/**
 * Reads what `validateQuery` attached. A missing value means the route was wired without the
 * middleware, so it throws rather than handing a controller an empty filter set.
 */
export function getValidatedQuery<TOutput>(req: Request): TOutput {
  if (req.validatedQuery === undefined) {
    throw new Error('Route is missing validateQuery middleware.');
  }

  return req.validatedQuery as TOutput;
}

/** Params are a plain dictionary, so the parsed values are merged in place. */
export function validateParams<TOutput extends Record<string, string>>(schema: ZodType<TOutput>) {
  return function validate(req: Request, _res: Response, next: NextFunction): void {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      next(result.error);
      return;
    }

    Object.assign(req.params, result.data);
    next();
  };
}

/**
 * Reads the `:id` that `validateParams` checked. Like `getUserId`, anything other than a single
 * string can only mean the route was wired without its middleware, so it fails closed instead of
 * querying for `undefined`.
 */
export function getIdParam(req: Request): string {
  const id = req.params.id;

  if (typeof id !== 'string') {
    throw new Error('Route is missing an :id parameter.');
  }

  return id;
}
