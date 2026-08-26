import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ApiError } from './errors.js';

/**
 * Every route validates at the boundary. The parsed value replaces the raw one,
 * so downstream handlers see the coerced, defaulted, typed shape and never the
 * arbitrary JSON that arrived.
 */
export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw ApiError.badRequest(
      'validation_failed',
      'Request body did not match the expected shape.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export function parseQuery<T>(schema: ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw ApiError.badRequest(
      'validation_failed',
      'Query parameters did not match the expected shape.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}


/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
