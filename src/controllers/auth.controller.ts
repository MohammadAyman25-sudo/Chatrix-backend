import type { Request, Response } from 'express';
import { z } from 'zod';
import { User } from '../models/user.model.js';
import type { UserDocument } from '../models/user.model.js';
import { HttpError } from '../middleware/error.middleware.js';
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
  verifyRefreshToken,
} from '../utils/token.js';

const registerSchema = z.object({
  username: z.string().min(3).max(32),
  email: z.email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

function toPublicUser(user: UserDocument) {
  return {
    id: user.id as string,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
    createdAt: user.createdAt,
  };
}

export async function register(req: Request, res: Response): Promise<void> {
  const data = registerSchema.parse(req.body);

  const existing = await User.findOne({
    $or: [{ email: data.email }, { username: data.username }],
  });

  if (existing) {
    throw new HttpError(409, 'Email or username already in use');
  }

  const user = await User.create(data);
  setAuthCookies(res, user.id as string);
  res.status(201).json({ user: toPublicUser(user) });
}

export async function login(req: Request, res: Response): Promise<void> {
  const data = loginSchema.parse(req.body);

  const user = await User.findOne({ email: data.email }).select('+password');
  if (!user || !(await user.comparePassword(data.password))) {
    throw new HttpError(401, 'Invalid email or password');
  }

  setAuthCookies(res, user.id as string);
  res.json({ user: toPublicUser(user) });
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

  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(401, 'Invalid or expired token');
  }

  setAuthCookies(res, user.id as string);
  res.status(204).end();
}

export function logout(_req: Request, res: Response): void {
  clearAuthCookies(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.user?.id);
  if (!user) {
    throw new HttpError(404, 'User not found');
  }
  res.json({ user: toPublicUser(user) });
}
