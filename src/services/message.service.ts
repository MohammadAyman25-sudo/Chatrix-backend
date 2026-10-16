import mongoose from 'mongoose';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import { Message } from '../models/message.model.js';
import type { IMessage, MessageDocument, MessageStatus } from '../models/message.model.js';
import { Conversation } from '../models/conversation.model.js';
import type { ConversationDocument } from '../models/conversation.model.js';
import { User } from '../models/user.model.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { isOnline } from '../sockets/presence.js';
import {
  getConversationForMember,
  getOrCreateDirectConversation,
  getParticipantIdsForMember,
  toConversationDto,
} from './conversation.service.js';
import { queueNewMessageNotification } from './notification.service.js';
import { HttpError } from '../middleware/error.middleware.js';
import type { ConversationDto, MessageDto } from '../types/chat.js';

export const attachmentSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file']),
  // Either an absolute URL (R2/CDN) or an app-relative path (`/uploads/...`,
  // used by local disk storage). `z.string().url()` would reject the latter.
  url: z
    .string()
    .refine((value) => value.startsWith('/') || URL.canParse(value), 'Invalid attachment url'),
  key: z.string().optional(),
  name: z.string().min(1),
  size: z.number().int().positive(),
  mimeType: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().int().positive().optional(),
});

export const sendMessageSchema = z
  .object({
    conversationId: z.string().min(1),
    content: z.string().trim().max(4000).optional(),
    clientTempId: z.string().optional(),
    type: z.enum(['text', 'image', 'video', 'audio', 'file']).optional().default('text'),
    attachments: z.array(attachmentSchema).optional(),
    replyToId: z.string().min(1).optional(),
    /**
     * Reply to the quoted message privately: instead of posting to the current
     * conversation, deliver a direct message to the quoted message's author.
     * Requires `replyToId`.
     */
    replyPrivately: z.boolean().optional().default(false),
  })
  .refine(
    (value) => {
      const hasContent = value.content && value.content.trim().length > 0;
      const hasAttachments = value.attachments && value.attachments.length > 0;
      return hasContent || hasAttachments;
    },
    { message: 'Message must have content or attachments' },
  );
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/** Senders may only edit their own messages within this window of sending. */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000;

export const editMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});
export type EditMessageInput = z.infer<typeof editMessageSchema>;

export const listMessagesSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;

/**
 * Where a forward should be delivered: existing conversations (`conversationIds`)
 * and/or users (`userIds`, resolved to their direct conversation, creating it if
 * needed). At least one target of either kind is required.
 */
export const forwardMessageSchema = z
  .object({
    conversationIds: z.array(z.string().min(1)).max(20).default([]),
    userIds: z.array(z.string().min(1)).max(20).default([]),
  })
  .refine((value) => value.conversationIds.length > 0 || value.userIds.length > 0, {
    message: 'Provide at least one target conversation or user',
  });
export type ForwardMessageInput = z.infer<typeof forwardMessageSchema>;

/** Whether a message sent at `createdAt` can still be edited at `now`. */
export function isWithinEditWindow(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() <= MESSAGE_EDIT_WINDOW_MS;
}

interface PopulatedSender {
  _id: mongoose.Types.ObjectId;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

interface PopulatedReplySender {
  _id: mongoose.Types.ObjectId;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

interface PopulatedReply {
  _id: mongoose.Types.ObjectId;
  content?: string;
  type?: 'text' | 'image' | 'video' | 'audio' | 'file';
  attachments?: IMessage['attachments'];
  sender?: PopulatedReplySender;
}

/**
 * Aggregate per-message status from the sender's perspective:
 * `read` once every recipient has read, `delivered` once every recipient has
 * received, otherwise `sent`. Self/empty conversations read as `read`.
 */
export function computeMessageStatus(message: MessageDocument): MessageStatus {
  const recipients = message.recipients ?? [];
  if (recipients.length === 0) {
    return 'read';
  }
  const readTo = new Set(message.readTo.map((id) => id.toString()));
  const deliveredTo = new Set(message.deliveredTo.map((id) => id.toString()));

  if (recipients.every((id) => readTo.has(id.toString()))) {
    return 'read';
  }
  if (recipients.every((id) => deliveredTo.has(id.toString()))) {
    return 'delivered';
  }
  return 'sent';
}

export function toMessageDto(message: MessageDocument): MessageDto {
  const sender = message.sender as unknown as PopulatedSender;
  const attachments = (message.attachments ?? []).map((attachment) => ({
    type: attachment.type,
    url: attachment.url,
    name: attachment.name,
    size: attachment.size,
    mimeType: attachment.mimeType,
    width: attachment.width,
    height: attachment.height,
    duration: attachment.duration,
  }));

  let replyTo: MessageDto['replyTo'];
  const reply = message.replyTo as unknown as PopulatedReply | undefined;
  if (reply) {
    const replySender = reply.sender as PopulatedReplySender | undefined;
    const replyAttachments = (reply.attachments ?? []).map((attachment) => ({
      type: attachment.type,
      url: attachment.url,
      name: attachment.name,
      size: attachment.size,
      mimeType: attachment.mimeType,
      width: attachment.width,
      height: attachment.height,
      duration: attachment.duration,
    }));
    replyTo = {
      id: reply._id.toString(),
      content: reply.content || '',
      type: reply.type || 'text',
      attachments: replyAttachments,
      sender: replySender
        ? {
            id: replySender._id.toString(),
            username: replySender.username,
            displayName: replySender.displayName ?? null,
            avatarUrl: replySender.avatarUrl ?? null,
          }
        : {
            id: '',
            username: '',
            displayName: null,
            avatarUrl: null,
          },
    };
  }

  return {
    id: message.id as string,
    conversationId: message.conversation.toString(),
    content: message.content || '',
    type: message.type || 'text',
    attachments,
    sender: {
      id: sender._id.toString(),
      username: sender.username,
      displayName: sender.displayName ?? null,
      avatarUrl: sender.avatarUrl ?? null,
    },
    ...(replyTo && { replyTo }),
    status: computeMessageStatus(message),
    editedAt: message.editedAt ?? null,
    forwarded: message.forwarded ?? false,
    createdAt: message.createdAt,
  };
}

export interface SendMessageResult {
  message: MessageDto;
  participantIds: string[];
  /**
   * Set only when a private reply had to create a brand-new direct
   * conversation. Callers broadcast `conversation:new` so both sides learn
   * about it before the `message:new`.
   */
  createdConversation?: ConversationDto;
}

export async function sendMessage(
  input: SendMessageInput & { senderId: string },
): Promise<SendMessageResult> {
  // The conversation the request was addressed to (and that the user must be a
  // member of). For a private reply this is the *source* conversation; the
  // message itself is posted to the direct conversation with the author.
  const source = await getConversationForMember(input.conversationId, input.senderId);

  // The message being replied to is always looked up in the source
  // conversation, so an id from another conversation can never be quoted.
  let replied: MessageDocument | null = null;
  if (input.replyToId && mongoose.isValidObjectId(input.replyToId)) {
    replied = await Message.findOne({ _id: input.replyToId, conversation: source._id });
  }

  if (input.replyPrivately && !replied) {
    throw new HttpError(400, 'Cannot reply privately: original message not found');
  }

  let conversation = source;
  let createdDirect = false;
  const replyTo = (replied?._id ?? undefined) as mongoose.Types.ObjectId | undefined;

  if (input.replyPrivately && replied) {
    const authorId = replied.sender.toString();
    if (authorId === input.senderId) {
      throw new HttpError(400, 'Cannot reply privately to your own message');
    }

    const result = await getOrCreateDirectConversation(input.senderId, authorId);
    conversation = result.conversation;
    createdDirect = result.created;
  }

  const participantIds = conversation.participants.map((participant) => participant.toString());
  const recipientIds = participantIds.filter((id) => id !== input.senderId);

  // Anyone already online is delivered immediately; offline recipients are
  // marked delivered when they next connect (see `markPendingDelivered`).
  const deliveredTo = recipientIds.filter((id) => isOnline(id));

  // Determine message type based on attachments if not explicitly set
  let messageType = input.type ?? 'text';
  if (input.attachments && input.attachments.length > 0) {
    if (input.type) {
      messageType = input.type;
    } else {
      const firstAttachment = input.attachments[0];
      messageType = firstAttachment?.type ?? 'file';
      if (input.attachments.length > 1) {
        // Mixed types treated as file
        messageType = 'file';
      }
    }
  }

  const message = await Message.create({
    conversation: conversation._id,
    sender: input.senderId,
    content: input.content ?? '',
    type: messageType,
    attachments: input.attachments ?? [],
    ...(replyTo && { replyTo }),
    recipients: recipientIds,
    deliveredTo,
  });
  await message.populate('sender', 'username displayName avatarUrl');
  if (replyTo) {
    await message.populate('replyTo', 'content type attachments sender');
    await message.populate('replyTo.sender', 'username displayName avatarUrl');
  }

  conversation.lastMessage = message._id as mongoose.Types.ObjectId;
  conversation.lastMessageAt = message.createdAt;
  await conversation.save();

  const messageDto = toMessageDto(message);

  // Email offline recipients (synchronous, non-blocking: it only enqueues). The
  // sender is excluded; online users already receive `message:new`.
  queueNewMessageNotification({
    conversationId: conversation.id as string,
    conversationType: conversation.type,
    conversationName: conversation.name ?? null,
    senderName: messageDto.sender.displayName ?? messageDto.sender.username,
    messageType: messageDto.type,
    messageContent: messageDto.content,
    recipientIds,
  });

  // Populate after save (populating the live doc would write back objects).
  let createdConversation: ConversationDto | undefined;
  if (createdDirect) {
    const populated = await Conversation.findById(conversation._id).populate(
      'participants',
      'username displayName avatarUrl',
    );
    if (populated) {
      createdConversation = toConversationDto(populated);
    }
  }

  return {
    message: messageDto,
    participantIds,
    ...(createdConversation && { createdConversation }),
  };
}

export interface EditMessageResult {
  message: MessageDto;
  participantIds: string[];
}

/**
 * Edits the content of a text message. Only the original sender may edit, only
 * text messages (not media), and only within `MESSAGE_EDIT_WINDOW_MS` of
 * sending. Marks the message with `editedAt` so clients can show "edited".
 */
export async function editMessage(
  input: EditMessageInput & { conversationId: string; messageId: string; userId: string },
): Promise<EditMessageResult> {
  const conversation = await getConversationForMember(input.conversationId, input.userId);

  if (!mongoose.isValidObjectId(input.messageId)) {
    throw new HttpError(404, 'Message not found');
  }
  const message = await Message.findOne({
    _id: input.messageId,
    conversation: conversation._id,
  });
  if (!message) {
    throw new HttpError(404, 'Message not found');
  }
  if (message.sender.toString() !== input.userId) {
    throw new HttpError(403, 'You can only edit your own messages');
  }
  if ((message.type ?? 'text') !== 'text') {
    throw new HttpError(400, 'Only text messages can be edited');
  }
  if (!isWithinEditWindow(message.createdAt)) {
    throw new HttpError(400, 'Messages can only be edited within 15 minutes of sending');
  }

  message.content = input.content;
  message.editedAt = new Date();
  await message.save();

  await message.populate('sender', 'username displayName avatarUrl');
  if (message.replyTo) {
    await message.populate('replyTo', 'content type attachments sender');
    await message.populate('replyTo.sender', 'username displayName avatarUrl');
  }

  return {
    message: toMessageDto(message),
    participantIds: conversation.participants.map((participant) => participant.toString()),
  };
}

export interface ForwardedCopy {
  message: MessageDto;
  /** Participants to notify (the sender is filtered out by the emitter). */
  participantIds: string[];
}

export interface ForwardMessageResult {
  /** One copied message per target conversation (in target order). */
  messages: MessageDto[];
  /** Per-copy participant lists, so callers can emit `message:new` per target. */
  deliveries: ForwardedCopy[];
  /**
   * Direct conversations that had to be created for `userIds` targets. Callers
   * broadcast `conversation:new` for these before the corresponding message.
   */
  createdConversations: ConversationDto[];
}

/**
 * Forwards a message to other conversations and/or users. The copy keeps the
 * original content and attachments but is re-attributed to the forwarder and
 * flagged `forwarded` (recipients never learn the original author). The caller
 * must be a member of the source conversation and of every target conversation;
 * `userIds` are resolved to direct conversations, created on demand. All targets
 * are validated before anything is written so a bad id can't cause a partial
 * forward.
 */
export async function forwardMessage(
  input: ForwardMessageInput & {
    conversationId: string;
    messageId: string;
    userId: string;
  },
): Promise<ForwardMessageResult> {
  const source = await getConversationForMember(input.conversationId, input.userId);

  if (!mongoose.isValidObjectId(input.messageId)) {
    throw new HttpError(404, 'Message not found');
  }
  const original = await Message.findOne({
    _id: input.messageId,
    conversation: source._id,
  });
  if (!original) {
    throw new HttpError(404, 'Message not found');
  }

  // Resolve every target up front (Map dedupes when an id and a user point at
  // the same conversation) so validation errors abort before any write.
  const targets = new Map<string, ConversationDocument>();
  const createdConversationIds: string[] = [];

  for (const conversationId of input.conversationIds) {
    const conversation = await getConversationForMember(conversationId, input.userId);
    targets.set(conversation.id as string, conversation);
  }

  const userIds = [...new Set(input.userIds.map(String))];
  if (userIds.includes(input.userId)) {
    throw new HttpError(400, 'Cannot forward a message to yourself');
  }
  if (userIds.some((id) => !mongoose.isValidObjectId(id))) {
    throw new HttpError(400, 'Invalid user id');
  }
  if (userIds.length > 0) {
    const existingUsers = await User.countDocuments({ _id: { $in: userIds } });
    if (existingUsers !== userIds.length) {
      throw new HttpError(400, 'One or more users do not exist');
    }
  }

  for (const otherUserId of userIds) {
    const { conversation, created } = await getOrCreateDirectConversation(
      input.userId,
      otherUserId,
    );
    const id = conversation.id as string;
    if (created && !targets.has(id)) {
      createdConversationIds.push(id);
    }
    targets.set(id, conversation);
  }

  const deliveries: ForwardedCopy[] = [];
  for (const conversation of targets.values()) {
    const participantIds = conversation.participants.map((participant) => participant.toString());
    const recipientIds = participantIds.filter((id) => id !== input.userId);
    // Forwarding to a DM whose only other member is offline still counts as
    // sent; online recipients are marked delivered immediately, like a send.
    const deliveredTo = recipientIds.filter((id) => isOnline(id));

    const message = await Message.create({
      conversation: conversation._id,
      sender: input.userId,
      content: original.content,
      type: original.type,
      attachments: original.attachments ?? [],
      forwarded: true,
      recipients: recipientIds,
      deliveredTo,
    });
    await message.populate('sender', 'username displayName avatarUrl');

    conversation.lastMessage = message._id as mongoose.Types.ObjectId;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    const messageDto = toMessageDto(message);

    // Each forwarded copy is a new message, so it notifies offline recipients
    // (deduped per conversation via notification.service).
    queueNewMessageNotification({
      conversationId: conversation.id as string,
      conversationType: conversation.type,
      conversationName: conversation.name ?? null,
      senderName: messageDto.sender.displayName ?? messageDto.sender.username,
      messageType: messageDto.type,
      messageContent: messageDto.content,
      recipientIds,
    });

    deliveries.push({ message: messageDto, participantIds });
  }

  const createdConversations: ConversationDto[] = [];
  for (const id of createdConversationIds) {
    const populated = await Conversation.findById(id).populate(
      'participants',
      'username displayName avatarUrl',
    );
    if (populated) {
      createdConversations.push(toConversationDto(populated));
    }
  }

  return {
    messages: deliveries.map((delivery) => delivery.message),
    deliveries,
    createdConversations,
  };
}

export async function listMessages(
  input: { conversationId: string; userId: string } & ListMessagesInput,
): Promise<{ items: MessageDto[]; nextCursor: string | null; hasMore: boolean }> {
  const conversation = await getConversationForMember(input.conversationId, input.userId);

  // Keyset pagination: `_id` descending. Older pages are fetched with a cursor
  // pointing at the oldest message the client already has.
  const filter: QueryFilter<IMessage> = { conversation: conversation._id };
  if (input.cursor) {
    filter._id = { $lt: new mongoose.Types.ObjectId(decodeCursor(input.cursor)) };
  }

  const docs = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(input.limit + 1)
    .populate('sender', 'username displayName avatarUrl')
    .populate('replyTo', 'content type attachments sender')
    .populate('replyTo.sender', 'username displayName avatarUrl');

  const hasMore = docs.length > input.limit;
  const page = hasMore ? docs.slice(0, input.limit) : docs;
  const oldest = page.at(-1);

  return {
    items: page.map(toMessageDto),
    nextCursor: hasMore && oldest ? encodeCursor(oldest.id as string) : null,
    hasMore,
  };
}

/**
 * Marks every message addressed to `userId` that they have not yet received as
 * delivered (run on connect). Returns the affected conversation/sender pairs so
 * the caller can notify senders over the socket.
 *
 * Messages the user has already read are skipped: `read` implies `delivered`,
 * and status is monotonic (`sent` -> `delivered` -> `read`), so touching them
 * would only re-notify the sender with a `delivered` status *below* the `read`
 * status they already have. The `readTo` guard is applied to the write as well
 * so a concurrent `message:read` between the query and the update can never be
 * downgraded.
 */
export async function markPendingDelivered(
  userId: string,
): Promise<Array<{ conversationId: string; senderId: string }>> {
  const pending = await Message.find({
    recipients: userId,
    deliveredTo: { $ne: userId },
    readTo: { $ne: userId },
  }).select('conversation sender');

  if (pending.length === 0) {
    return [];
  }

  await Message.updateMany(
    { _id: { $in: pending.map((message) => message._id) }, readTo: { $ne: userId } },
    { $addToSet: { deliveredTo: userId } },
  );

  const pairs = new Map<string, { conversationId: string; senderId: string }>();
  for (const message of pending) {
    const conversationId = message.conversation.toString();
    const senderId = message.sender.toString();
    pairs.set(`${conversationId}:${senderId}`, { conversationId, senderId });
  }
  return [...pairs.values()];
}

/**
 * Marks all messages the user received in a conversation as read (and
 * delivered). Returns the participant ids to notify, or null if the user is not
 * a member.
 */
export async function markConversationRead(
  conversationId: string,
  userId: string,
): Promise<string[] | null> {
  const participants = await getParticipantIdsForMember(conversationId, userId);
  if (!participants) {
    return null;
  }

  await Message.updateMany(
    { conversation: conversationId, recipients: userId, readTo: { $ne: userId } },
    { $addToSet: { readTo: userId, deliveredTo: userId } },
  );

  return participants;
}
