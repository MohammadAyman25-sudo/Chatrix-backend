import mongoose from 'mongoose';
import type { QueryFilter } from 'mongoose';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Conversation } from '../models/conversation.model.js';
import type { ConversationDocument } from '../models/conversation.model.js';
import { Message } from '../models/message.model.js';
import type { IMessage, MessageDocument } from '../models/message.model.js';
import { HttpError } from '../middleware/error.middleware.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { getIO } from '../sockets/index.js';

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

const listMessagesSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

interface PopulatedSender {
  _id: mongoose.Types.ObjectId;
  username: string;
  avatarUrl?: string;
}

function toMessageDto(message: MessageDocument) {
  const sender = message.sender as unknown as PopulatedSender;
  return {
    id: message.id as string,
    conversationId: message.conversation.toString(),
    content: message.content,
    sender: {
      id: sender._id.toString(),
      username: sender.username,
      avatarUrl: sender.avatarUrl ?? null,
    },
    createdAt: message.createdAt,
  };
}

// Express 5 types route params as `string | string[]`; normalize to a single string.
function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

async function assertMembership(
  conversationId: string,
  userId: string,
): Promise<ConversationDocument> {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new HttpError(400, 'Invalid conversation id');
  }
  const conversation = await Conversation.findOne({ _id: conversationId, participants: userId });
  if (!conversation) {
    throw new HttpError(404, 'Conversation not found');
  }
  return conversation;
}

export async function sendMessage(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }

  const conversation = await assertMembership(routeParam(req.params.conversationId), userId);
  const { content } = sendMessageSchema.parse(req.body);

  const message = await Message.create({
    conversation: conversation._id,
    sender: userId,
    content,
  });
  await message.populate('sender', 'username avatarUrl');

  conversation.lastMessage = message._id as mongoose.Types.ObjectId;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  const dto = toMessageDto(message);
  const rooms = conversation.participants.map((participant) => `user:${participant.toString()}`);
  getIO()?.to(rooms).emit('message:new', dto);

  res.status(201).json({ message: dto });
}

export async function listMessages(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }

  const conversation = await assertMembership(routeParam(req.params.conversationId), userId);
  const { cursor, limit } = listMessagesSchema.parse(req.query);

  // Keyset pagination: `_id` descending. Older pages are fetched with a cursor
  // pointing at the oldest message the client already has.
  const filter: QueryFilter<IMessage> = { conversation: conversation._id };
  if (cursor) {
    filter._id = { $lt: new mongoose.Types.ObjectId(decodeCursor(cursor)) };
  }

  const docs = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .populate('sender', 'username avatarUrl');

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const oldest = page.at(-1);

  res.json({
    items: page.map(toMessageDto),
    nextCursor: hasMore && oldest ? encodeCursor(oldest.id as string) : null,
    hasMore,
  });
}
