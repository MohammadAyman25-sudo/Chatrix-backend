import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  addGroupParticipantsHandler,
  createConversationHandler,
  deleteGroupAvatarHandler,
  getConversationPresenceHandler,
  listConversationsHandler,
  updateGroupAvatarHandler,
  updateGroupHandler,
} from '../controllers/conversation.controller.js';
import {
  editMessageHandler,
  forwardMessageHandler,
  listMessagesHandler,
  sendMessageHandler,
  uploadAttachmentsHandler,
} from '../controllers/message.controller.js';
import { uploadAvatar, uploadMessageAttachments } from '../middleware/upload.middleware.js';
import {
  attachmentLimiter,
  messageSendLimiter,
  uploadLimiter,
} from '../middleware/rateLimit.middleware.js';

export const conversationRouter = Router();

conversationRouter.use(requireAuth);

conversationRouter.post('/', createConversationHandler);
conversationRouter.get('/', listConversationsHandler);
// Group name/icon: any member may edit (see conversation.service).
conversationRouter.patch('/:conversationId', updateGroupHandler);
conversationRouter.post(
  '/:conversationId/avatar',
  uploadLimiter,
  uploadAvatar,
  updateGroupAvatarHandler,
);
conversationRouter.delete('/:conversationId/avatar', deleteGroupAvatarHandler);
// Invite users to a group (any member may invite).
conversationRouter.post('/:conversationId/participants', addGroupParticipantsHandler);
conversationRouter.get('/:conversationId/presence', getConversationPresenceHandler);
conversationRouter.get('/:conversationId/messages', listMessagesHandler);
conversationRouter.patch('/:conversationId/messages/:messageId', editMessageHandler);
// Forward a message to other conversations and/or users (each copy is a send).
conversationRouter.post(
  '/:conversationId/messages/:messageId/forward',
  messageSendLimiter,
  forwardMessageHandler,
);

// Upload media (voice notes, images, …) and get attachment metadata back; the
// message itself is then sent over Socket.IO with `message:send`.
conversationRouter.post(
  '/:conversationId/attachments',
  attachmentLimiter,
  uploadMessageAttachments,
  uploadAttachmentsHandler,
);
conversationRouter.post(
  '/:conversationId/messages',
  messageSendLimiter,
  uploadMessageAttachments,
  sendMessageHandler,
);
