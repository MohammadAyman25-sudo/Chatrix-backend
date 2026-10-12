import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { createConversation, listConversations } from '../controllers/conversation.controller.js';
import { listMessages, sendMessage } from '../controllers/message.controller.js';

export const conversationRouter = Router();

conversationRouter.use(requireAuth);

conversationRouter.post('/', createConversation);
conversationRouter.get('/', listConversations);
conversationRouter.get('/:conversationId/messages', listMessages);
conversationRouter.post('/:conversationId/messages', sendMessage);
