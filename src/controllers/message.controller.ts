import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/error.middleware.js';
import {
  editMessage,
  editMessageSchema,
  forwardMessage,
  forwardMessageSchema,
  listMessages,
  listMessagesSchema,
  sendMessage,
  sendMessageSchema,
} from '../services/message.service.js';
import { getConversationForMember } from '../services/conversation.service.js';
import {
  emitConversationNew,
  emitForwardedMessages,
  emitMessageEdited,
  emitNewMessage,
} from '../sockets/emitters.js';
import { storage } from '../services/storage.service.js';
import { getFileExtension } from '../services/user.service.js';
import { determineMediaType } from '../middleware/upload.middleware.js';
import { routeParam } from '../utils/routeParam.js';
import type { AttachmentDto } from '../types/chat.js';

function requireUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }
  return userId;
}

/**
 * Uploads each multipart file to object storage and returns attachment metadata.
 * Shared by the JSON/multipart send endpoint and the dedicated attachment-upload
 * endpoint used for the socket send flow.
 */
async function storeUploadedFiles(
  files: Express.Multer.File[],
  conversationId: string,
  userId: string,
): Promise<Array<AttachmentDto & { key: string }>> {
  const attachments: Array<AttachmentDto & { key: string }> = [];
  for (const file of files) {
    const extension = getFileExtension(file.mimetype) || '';
    const key = `messages/${conversationId}/${userId}/${randomUUID()}${extension}`;
    const { url } = await storage.upload({
      key,
      buffer: file.buffer,
      contentType: file.mimetype,
    });
    attachments.push({
      type: determineMediaType(file.mimetype),
      url,
      key,
      name: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });
  }
  return attachments;
}

/** Reads an optional integer `duration` (seconds) from a multipart body. */
function parseDuration(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return undefined;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined;
}

export async function sendMessageHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const conversationId = routeParam(req.params.conversationId);

  const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
  const uploaded = req.file ? [...files, req.file] : files;
  const attachments =
    uploaded.length > 0 ? await storeUploadedFiles(uploaded, conversationId, userId) : [];

  const input = sendMessageSchema.parse({
    ...(req.body as Record<string, unknown>),
    conversationId,
    attachments: attachments.length > 0 ? attachments : undefined,
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

/**
 * Uploads message media (including voice notes) and returns attachment metadata
 * WITHOUT creating a message. The client then sends the message over Socket.IO
 * (`message:send`) with the returned attachments. Only conversation members can
 * upload (non-members get 404, so ids cannot be probed).
 */
export async function uploadAttachmentsHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const conversationId = routeParam(req.params.conversationId);

  await getConversationForMember(conversationId, userId);

  const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
  if (files.length === 0) {
    throw new HttpError(400, 'No files uploaded (expected multipart field "files")');
  }

  const duration = parseDuration((req.body as Record<string, unknown> | undefined)?.duration);
  const attachments = (await storeUploadedFiles(files, conversationId, userId)).map((attachment) =>
    duration !== undefined && (attachment.type === 'audio' || attachment.type === 'video')
      ? { ...attachment, duration }
      : attachment,
  );

  res.status(201).json({ attachments });
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
