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
import type {
  ConversationDto,
  MessageDto,
  MessageInfoDto,
  MessageReceiptDto,
  ParticipantDto,
} from '../types/chat.js';

export const attachmentSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file']),
  // Absolute URL in the R2 public bucket. App-relative paths are still accepted
  // so attachments stored before the move to R2 (`/uploads/...`) keep validating;
  // new uploads always produce absolute R2 URLs.
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
 * Recipients whose read must be treated as *not read* when aggregating status.
 * Set for the other member(s) of a **direct** conversation who disabled read
 * receipts: their read state is still stored (and used to compute delivery),
 * but it must never surface to the sender as `read`. Groups ignore the setting,
 * so this stays empty for them.
 */
export interface MessageStatusContext {
  hiddenReadRecipients?: Iterable<string>;
}

/**
 * Aggregate per-message status from the sender's perspective:
 * `read` once every recipient has read, `delivered` once every recipient has
 * received, otherwise `sent`. Self/empty conversations read as `read`.
 *
 * Recipients in `context.hiddenReadRecipients` (a direct chat peer who turned
 * read receipts off) are excluded from the read test while still counting as
 * delivered, so a message they read caps at `delivered` instead of `read`.
 */
export function computeMessageStatus(
  message: MessageDocument,
  context?: MessageStatusContext,
): MessageStatus {
  const recipients = message.recipients ?? [];
  if (recipients.length === 0) {
    return 'read';
  }
  const hidden = new Set(context?.hiddenReadRecipients ?? []);
  const readTo = new Set(message.readTo.map((id) => id.toString()));
  // A read always implies delivered, even when the read itself is hidden.
  const deliveredTo = new Set([
    ...message.deliveredTo.map((id) => id.toString()),
    ...readTo,
  ]);

  if (recipients.every((id) => readTo.has(id.toString()) && !hidden.has(id.toString()))) {
    return 'read';
  }
  if (recipients.every((id) => deliveredTo.has(id.toString()))) {
    return 'delivered';
  }
  return 'sent';
}

/**
 * Ids of a conversation's participants whose read receipts are off. Only direct
 * conversations honour the setting (groups ignore it), so this is empty for
 * groups. The caller may appear in the set, but a message's `recipients` never
 * include its sender, so that has no effect on the aggregate.
 */
export async function hiddenReadRecipientIds(
  conversation: ConversationDocument,
): Promise<Set<string>> {
  if (conversation.type !== 'direct') {
    return new Set();
  }
  const participantIds = conversation.participants.map((participant) => participant.toString());
  if (participantIds.length === 0) {
    return new Set();
  }
  const users = await User.find({ _id: { $in: participantIds } }).select('settings.readReceipts');

  const hidden = new Set<string>();
  for (const user of users) {
    if (user.settings?.readReceipts === false) {
      hidden.add(user.id as string);
    }
  }
  return hidden;
}

export function toMessageDto(
  message: MessageDocument,
  statusContext?: MessageStatusContext,
): MessageDto {
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
    status: computeMessageStatus(message, statusContext),
    editedAt: message.editedAt ?? null,
    forwarded: message.forwarded ?? false,
    createdAt: message.createdAt,
  };
}

/** Inputs for the pure "Message info" projection (no DB access). */
export interface MessageInfoInput {
  conversationType: 'direct' | 'group';
  /** Recipients in display order (participants minus the sender). */
  recipients: ParticipantDto[];
  deliveredTo: string[];
  readTo: string[];
  deliveredAt?: Map<string, Date> | null;
  readAt?: Map<string, Date> | null;
  /** Recipient id -> their `settings.readReceipts` (defaults to true). */
  readReceipts?: Map<string, boolean> | null;
}

export interface MessageInfoProjection {
  deliveredTo: MessageReceiptDto[];
  readBy: MessageReceiptDto[];
  pending: ParticipantDto[];
  readReceiptsDisabled: boolean;
}

/**
 * Builds the delivery/read receipt detail for a message from the sender's point
 * of view. Privacy rules:
 *
 * - **Direct** conversations reveal a recipient's read time only when their
 *   `settings.readReceipts` is on; otherwise they are omitted from `readBy` and
 *   `readReceiptsDisabled` is set. Delivery is always shown.
 * - **Group** conversations ignore `readReceipts` entirely and list every member
 *   in `deliveredTo` / `readBy` with their times.
 *
 * A recipient who read is always treated as delivered (read implies delivered),
 * even if the stored `deliveredTo` array lacks them.
 */
export function buildMessageInfo(input: MessageInfoInput): MessageInfoProjection {
  const isGroup = input.conversationType === 'group';
  const deliveredSet = new Set(input.deliveredTo);
  const readSet = new Set(input.readTo);
  const timeOf = (map: Map<string, Date> | null | undefined, id: string): Date | null =>
    map?.get(id) ?? null;

  const deliveredTo: MessageReceiptDto[] = [];
  const readBy: MessageReceiptDto[] = [];
  const pending: ParticipantDto[] = [];
  let readReceiptsDisabled = false;

  for (const user of input.recipients) {
    const id = user.id;
    const read = readSet.has(id);
    const delivered = deliveredSet.has(id) || read;
    // Groups ignore the setting; direct chats honour the reader's privacy.
    const receiptsOn = isGroup || (input.readReceipts?.get(id) ?? true);

    if (!isGroup && !receiptsOn) {
      readReceiptsDisabled = true;
    }
    // Whether this read may be shown at all (groups always; direct chats only
    // when the reader allows it). The *time* may still be unknown (legacy data).
    const revealRead = read && receiptsOn;
    if (revealRead) {
      readBy.push({ user, at: timeOf(input.readAt, id) });
    }
    if (delivered) {
      // Fall back to the read time when a pre-timestamp message has no recorded
      // delivery time — safe because that read time is already being revealed.
      deliveredTo.push({
        user,
        at: timeOf(input.deliveredAt, id) ?? (revealRead ? timeOf(input.readAt, id) : null),
      });
    } else {
      pending.push(user);
    }
  }

  return { deliveredTo, readBy, pending, readReceiptsDisabled };
}

export interface GetMessageInfoInput {
  conversationId: string;
  messageId: string;
  userId: string;
}

/**
 * Delivery/read detail for one message. Only the **sender** may view it (like a
 * messaging app's "Message info" screen); anyone else gets 403. In a direct
 * conversation the other member's read time is withheld when their
 * `settings.readReceipts` is off (see `buildMessageInfo`).
 */
export async function getMessageInfo(input: GetMessageInfoInput): Promise<MessageInfoDto> {
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
    throw new HttpError(403, 'Only the sender can view message info');
  }

  const recipientIds = (message.recipients ?? []).map((id) => id.toString());
  const users = await User.find({ _id: { $in: recipientIds } }).select(
    'username displayName avatarUrl settings.readReceipts',
  );
  const byId = new Map(users.map((user) => [user.id as string, user]));

  // Keep the recipients order and drop ids whose user no longer exists.
  const recipients: ParticipantDto[] = [];
  const readReceipts = new Map<string, boolean>();
  for (const id of recipientIds) {
    const user = byId.get(id);
    if (!user) {
      continue;
    }
    recipients.push({
      id,
      username: user.username,
      displayName: user.displayName ?? null,
      avatarUrl: user.avatarUrl ?? null,
    });
    readReceipts.set(id, user.settings?.readReceipts ?? true);
  }

  const projection = buildMessageInfo({
    conversationType: conversation.type,
    recipients,
    deliveredTo: (message.deliveredTo ?? []).map((id) => id.toString()),
    readTo: (message.readTo ?? []).map((id) => id.toString()),
    deliveredAt: message.deliveredAt ?? null,
    readAt: message.readAt ?? null,
    readReceipts,
  });

  // Keep the aggregate status consistent with the (privacy-filtered) `readBy`:
  // a direct recipient who disabled read receipts caps its status at delivered.
  const hiddenReadRecipients =
    conversation.type === 'direct'
      ? new Set([...readReceipts].filter(([, receiptsOn]) => !receiptsOn).map(([id]) => id))
      : new Set<string>();

  return {
    messageId: message.id as string,
    conversationId: conversation.id as string,
    conversationType: conversation.type,
    status: computeMessageStatus(message, { hiddenReadRecipients }),
    ...projection,
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
  const deliveredAt = Object.fromEntries(deliveredTo.map((id) => [id, new Date()]));

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
    deliveredAt,
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
    message: toMessageDto(message, {
      hiddenReadRecipients: await hiddenReadRecipientIds(conversation),
    }),
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
    const deliveredAt = Object.fromEntries(deliveredTo.map((id) => [id, new Date()]));

    const message = await Message.create({
      conversation: conversation._id,
      sender: input.userId,
      content: original.content,
      type: original.type,
      attachments: original.attachments ?? [],
      forwarded: true,
      recipients: recipientIds,
      deliveredTo,
      deliveredAt,
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
  const hiddenReadRecipients = await hiddenReadRecipientIds(conversation);

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
    items: page.map((doc) => toMessageDto(doc, { hiddenReadRecipients })),
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

  const now = new Date();
  await Message.updateMany(
    // Re-check both guards so a concurrent `message:read` can't be downgraded.
    {
      _id: { $in: pending.map((message) => message._id) },
      deliveredTo: { $ne: userId },
      readTo: { $ne: userId },
    },
    {
      $addToSet: { deliveredTo: userId },
      // Record *when* for the "Message info" screen (idempotent `$set`).
      $set: { [`deliveredAt.${userId}`]: now },
    },
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

  const now = new Date();
  // Mark read (recording when). Split from delivery so an existing delivery
  // timestamp is never overwritten with the later read time.
  await Message.updateMany(
    { conversation: conversationId, recipients: userId, readTo: { $ne: userId } },
    {
      $addToSet: { readTo: userId },
      $set: { [`readAt.${userId}`]: now },
    },
  );
  // Mark delivered for anything not already delivered (e.g. read offline).
  await Message.updateMany(
    { conversation: conversationId, recipients: userId, deliveredTo: { $ne: userId } },
    {
      $addToSet: { deliveredTo: userId },
      $set: { [`deliveredAt.${userId}`]: now },
    },
  );

  return participants;
}
