import type { CookieOptions, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { env, isProduction } from '../config/env.js';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

export const REFRESH_COOKIE_PATH = '/api/auth';

export interface TokenPayload {
  sub: string;
  tokenType: 'access' | 'refresh';
}

const accessExpiresIn = env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'];
const refreshExpiresIn = env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'];

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, tokenType: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: accessExpiresIn,
  });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, tokenType: 'refresh' }, env.JWT_REFRESH_SECRET, {
    expiresIn: refreshExpiresIn,
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
}

const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
};

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function setAuthCookies(res: Response, userId: string): void {
  res.cookie(ACCESS_COOKIE, signAccessToken(userId), {
    ...baseCookieOptions,
    maxAge: ACCESS_MAX_AGE_MS,
  });
  res.cookie(REFRESH_COOKIE, signRefreshToken(userId), {
    ...baseCookieOptions,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookieOptions });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookieOptions, path: REFRESH_COOKIE_PATH });
}
