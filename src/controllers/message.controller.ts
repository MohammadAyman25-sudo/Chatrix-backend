import type { Request, Response } from 'express';
import { HttpError } from '../middleware/error.middleware.js';
import {
  editMessage,
  editMessageSchema,
  forwardMessage,
  forwardMessageSchema,
  getMessageInfo,
  listMessages,
  listMessagesSchema,
  sendMessage,
  sendMessageSchema,
} from '../services/message.service.js';
import { searchMessages, searchMessagesSchema } from '../services/search.service.js';
import { listConversationMedia, listMediaSchema } from '../services/media.service.js';
import {
  emitConversationNew,
  emitForwardedMessages,
  emitMessageEdited,
  emitNewMessage,
} from '../sockets/emitters.js';
import { routeParam } from '../utils/routeParam.js';

function requireUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }
  return userId;
}

export async function sendMessageHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const conversationId = routeParam(req.params.conversationId);

  const input = sendMessageSchema.parse({
    ...(req.body as Record<string, unknown>),
    conversationId,
  });

  const { message, participantIds, createdConversation } = await sendMessage({
    ...input,
    senderId: userId,
  });

  // A private reply may have created a direct conversation: announce it before
  // the message so recipients can resolve the conversation.
  if (createdConversation) {
    emitConversationNew(
      createdConversation.participants.map((participant) => participant.id),
      createdConversation,
      userId,
    );
  }

  emitNewMessage(participantIds, message, userId);
  res
    .status(201)
    .json({ message, ...(createdConversation && { conversation: createdConversation }) });
}

/** Edits the content of one of the caller's own text messages (within 15 min). */
export async function editMessageHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const input = editMessageSchema.parse(req.body);

  const { message, participantIds } = await editMessage({
    ...input,
    conversationId: routeParam(req.params.conversationId),
    messageId: routeParam(req.params.messageId),
    userId,
  });

  emitMessageEdited(participantIds, message, userId);
  res.json({ message });
}

export async function listMessagesHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);

  const { cursor, limit } = listMessagesSchema.parse(req.query);
  const result = await listMessages({
    conversationId: routeParam(req.params.conversationId),
    userId,
    cursor,
    limit,
  });

  res.json(result);
}

/**
 * Delivery/read receipts for one message ("Message info"). Sender only: anyone
 * else gets 403. Direct conversations withhold the other member's read time
 * when their `settings.readReceipts` is off; groups always show every member's
 * delivery and read times.
 */
export async function getMessageInfoHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const info = await getMessageInfo({
    conversationId: routeParam(req.params.conversationId),
    messageId: routeParam(req.params.messageId),
    userId,
  });

  res.json({ info });
}

/**
 * Lists a conversation's shareable content (media, documents, links) so the
 * client can render a "media, links and docs" tab without scanning every
 * message. Membership is enforced by the service (404 for non-members).
 */
export async function listConversationMediaHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const input = listMediaSchema.parse(req.query);

  res.json(
    await listConversationMedia({
      ...input,
      conversationId: routeParam(req.params.conversationId),
      userId,
    }),
  );
}

/**
 * Searches the messages of every conversation the caller belongs to. Matching
 * is normalization-based (case, accents, Arabic letter variants, … — see
 * `utils/searchText.ts`), not literal.
 */
export async function searchMessagesHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const input = searchMessagesSchema.parse(req.query);
  res.json(await searchMessages({ ...input, userId }));
}

/**
 * Forwards a message to other conversations and/or users (see
 * `forwardMessageSchema`). Each copy is a new message in the target chat.
 */
export async function forwardMessageHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const input = forwardMessageSchema.parse(req.body);

  const { messages, deliveries, createdConversations } = await forwardMessage({
    ...input,
    conversationId: routeParam(req.params.conversationId),
    messageId: routeParam(req.params.messageId),
    userId,
  });

  // Announce direct conversations created for `userIds` targets first, so
  // recipients can resolve the chat before its message arrives.
  emitForwardedMessages(deliveries, createdConversations, userId);

  res.status(201).json({
    messages,
    ...(createdConversations.length > 0 && { conversations: createdConversations }),
  });
}
