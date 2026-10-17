import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { searchMessagesHandler } from '../controllers/message.controller.js';
import { searchLimiter } from '../middleware/rateLimit.middleware.js';

export const messageRouter = Router();

messageRouter.use(requireAuth);

// Cross-conversation search over every chat the caller is a member of.
messageRouter.get('/search', searchLimiter, searchMessagesHandler);
