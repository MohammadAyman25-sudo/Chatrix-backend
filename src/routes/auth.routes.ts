import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authLimiter, refreshLimiter } from '../middleware/rateLimit.middleware.js';
import {
  login,
  logout,
  me,
  refresh,
  register,
  resendVerificationHandler,
  verifyEmailHandler,
} from '../controllers/auth.controller.js';

export const authRouter = Router();

authRouter.post('/register', authLimiter, register);
authRouter.post('/login', authLimiter, login);
// Both are unauthenticated, so they share the auth limiter to slow token guessing.
authRouter.post('/verify-email', authLimiter, verifyEmailHandler);
authRouter.post('/resend-verification', authLimiter, resendVerificationHandler);
authRouter.post('/refresh', refreshLimiter, refresh);
authRouter.post('/logout', logout);
authRouter.get('/me', requireAuth, me);
