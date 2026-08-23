import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

/** An error with an HTTP status and a code the client can branch on. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(code = 'unauthorized', message = 'Not authorised.'): ApiError {
    return new ApiError(401, code, message);
  }
  static forbidden(code = 'forbidden', message = 'Not permitted.'): ApiError {
    return new ApiError(403, code, message);
  }
  static notFound(code = 'not_found', message = 'Not found.'): ApiError {
    return new ApiError(404, code, message);
  }
  static gone(code: string, message: string): ApiError {
    return new ApiError(410, code, message);
  }
  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message);
  }
  static tooLarge(code: string, message: string): ApiError {
    return new ApiError(413, code, message);
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Request did not match the expected shape.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  // Unexpected. Log it in full, but never leak internals to the client — this
  // API is reachable by anyone holding a magic link.
  console.error('[api] unhandled error:', err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong.', details: null },
  });
}
