import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error(`${req.method} ${req.path}`, err);
    return res.status(err.status).json({ error: err.message });
  }

  // Any route calling schema.parse(req.body) throws a ZodError on invalid
  // input — without this, every validation failure anywhere in the app
  // (a missing field, wrong type, failed .min()/.email() check, etc.)
  // surfaced as a generic 500 instead of a clear 400 with the actual reason.
  if (err instanceof ZodError) {
    const message = err.errors
      .map(e => `${e.path.join('.') || 'value'}: ${e.message}`)
      .join('; ');
    return res.status(400).json({ error: message || 'Invalid request.' });
  }

  logger.error(`Unhandled error on ${req.method} ${req.path}`, err);
  return res.status(500).json({ error: 'Internal server error.' });
}
