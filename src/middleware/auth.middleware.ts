import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './error.middleware.js';
import { ACCESS_COOKIE, verifyAccessToken } from '../utils/token.js';

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = (req.cookies as Record<string, string | undefined>)[ACCESS_COOKIE];

  if (!token) {
    next(new HttpError(401, 'Not authenticated'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub };
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}
