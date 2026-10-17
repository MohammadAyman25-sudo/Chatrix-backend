import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  addGroupParticipantsHandler,
  createConversationHandler,
  deleteGroupAvatarHandler,
  getConversationPresenceHandler,
  listConversationsHandler,
  removeGroupParticipantHandler,
  updateGroupHandler,
} from '../controllers/conversation.controller.js';
import {
  editMessageHandler,
  forwardMessageHandler,
  getMessageInfoHandler,
  listConversationMediaHandler,
  listMessagesHandler,
  sendMessageHandler,
} from '../controllers/message.controller.js';
import { messageSendLimiter } from '../middleware/rateLimit.middleware.js';

export const conversationRouter = Router();

conversationRouter.use(requireAuth);

conversationRouter.post('/', createConversationHandler);
conversationRouter.get('/', listConversationsHandler);
// Group name/icon: any member may edit.
conversationRouter.patch('/:conversationId', updateGroupHandler);
conversationRouter.delete('/:conversationId/avatar', deleteGroupAvatarHandler);
// Invite users to a group (any member may invite).
conversationRouter.post('/:conversationId/participants', addGroupParticipantsHandler);
// Remove a member from a group (only the group owner may).
conversationRouter.delete(
  '/:conversationId/participants/:participantId',
  removeGroupParticipantHandler,
);
conversationRouter.get('/:conversationId/presence', getConversationPresenceHandler);
// Media, links and documents shared in the conversation.
conversationRouter.get('/:conversationId/media', listConversationMediaHandler);
conversationRouter.get('/:conversationId/messages', listMessagesHandler);
conversationRouter.patch('/:conversationId/messages/:messageId', editMessageHandler);
// Delivery/read receipt detail for one of the caller's own messages.
conversationRouter.get('/:conversationId/messages/:messageId/info', getMessageInfoHandler);
// Forward a message to other conversations and/or users (each copy is a send).
conversationRouter.post(
  '/:conversationId/messages/:messageId/forward',
  messageSendLimiter,
  forwardMessageHandler,
);
conversationRouter.post('/:conversationId/messages', messageSendLimiter, sendMessageHandler);
