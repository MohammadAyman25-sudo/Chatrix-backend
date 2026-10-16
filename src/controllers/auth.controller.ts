import type { Request, Response } from 'express';
import { HttpError } from '../middleware/error.middleware.js';
import { env } from '../config/env.js';
import {
  authenticateUser,
  getUserById,
  loginSchema,
  registerSchema,
  registerUser,
  resendVerification,
  resendVerificationSchema,
  verifyEmail,
  verifyEmailSchema,
} from '../services/auth.service.js';
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
  verifyRefreshToken,
} from '../utils/token.js';

export async function register(req: Request, res: Response): Promise<void> {
  const data = registerSchema.parse(req.body);
  const user = await registerUser(data);

  // With verification enabled the account has no session until the email is
  // confirmed (`login` returns 403 until then), so no cookies are issued here.
  if (env.EMAIL_VERIFICATION_ENABLED) {
    res.status(201).json({ user, emailVerificationSent: true });
    return;
  }

  setAuthCookies(res, user.id);
  res.status(201).json({ user });
}

export async function login(req: Request, res: Response): Promise<void> {
  const data = loginSchema.parse(req.body);
  const user = await authenticateUser(data);

  setAuthCookies(res, user.id);
  res.json({ user });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];

  let userId: string;
  try {
    if (!token) {
      throw new Error('missing refresh token');
    }
    userId = verifyRefreshToken(token).sub;
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }

  const user = await getUserById(userId);
  setAuthCookies(res, user.id);
  res.status(204).end();
}

export function logout(_req: Request, res: Response): void {
  clearAuthCookies(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    throw new HttpError(401, 'Not authenticated');
  }
  const user = await getUserById(req.user.id);
  res.json({ user });
}

/**
 * Redeems the token from the emailed verification link. No session needed —
 * the token itself proves ownership of the address.
 */
export async function verifyEmailHandler(req: Request, res: Response): Promise<void> {
  const data = verifyEmailSchema.parse(req.body);
  const user = await verifyEmail(data);
  res.json({ user });
}

/**
 * Always answers `202` with the same message, whether or not the address is
 * known or already verified, so it can't be used to enumerate accounts.
 */
export async function resendVerificationHandler(req: Request, res: Response): Promise<void> {
  const data = resendVerificationSchema.parse(req.body);
  await resendVerification(data);
  res
    .status(202)
    .json({ message: 'If that address has an unverified account, a verification email was sent.' });
}
