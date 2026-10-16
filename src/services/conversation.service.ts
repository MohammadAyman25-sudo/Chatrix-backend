import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Conversation } from '../models/conversation.model.js';
import type { ConversationDocument } from '../models/conversation.model.js';
import { Message } from '../models/message.model.js';
import { User } from '../models/user.model.js';
import { HttpError } from '../middleware/error.middleware.js';
import { getFileExtension } from './user.service.js';
import { storage } from './storage.service.js';
import type { ConversationDto, ParticipantDto } from '../types/chat.js';

const baseParticipantSchema = z.array(z.string()).min(1);

const directConversationSchema = z.object({
  participantIds: baseParticipantSchema,
  type: z.literal('direct'),
  name: z.never().optional(),
});

const groupConversationSchema = z.object({
  participantIds: baseParticipantSchema,
  type: z.literal('group'),
  name: z.string().trim().min(1).max(64),
});

export const createConversationSchema = z.discriminatedUnion('type', [
  directConversationSchema,
  groupConversationSchema,
]);

export type CreateConversationInput = z.infer<typeof createConversationSchema>;

/** Fields a group member may change about a group conversation. */
export const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(64),
});
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

/** Users to invite to a group conversation. */
export const addGroupMembersSchema = z.object({
  participantIds: z.array(z.string()).min(1).max(50),
});
export type AddGroupMembersInput = z.infer<typeof addGroupMembersSchema>;

interface PopulatedUser {
  _id: mongoose.Types.ObjectId;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

function toParticipantDto(user: PopulatedUser): ParticipantDto {
  return {
    id: user._id.toString(),
    username: user.username,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

export function toConversationDto(conversation: ConversationDocument): ConversationDto {
  const participants = conversation.participants as unknown as PopulatedUser[];
  return {
    id: conversation.id as string,
    type: conversation.type,
    name: conversation.name ?? null,
    avatarUrl: conversation.avatarUrl ?? null,
    participants: participants.map(toParticipantDto),
    lastMessageAt: conversation.lastMessageAt ?? null,
    createdAt: conversation.createdAt,
  };
}

function directKeyFor(userIds: string[]): string {
  return [...userIds].map(String).sort().join(':');
}

/** One row of the unread-count aggregation: `_id` is the conversation id. */
export interface UnreadCountRow {
  _id: mongoose.Types.ObjectId | string;
  count: number;
}

/** Builds a conversation-id -> unread-count lookup from aggregation rows. */
export function toUnreadCountMap(rows: UnreadCountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

/**
 * Finds or creates the direct conversation between two users. Idempotent on the
 * sorted `directKey`: a concurrent creation that loses the race on the unique
 * index falls back to reading the winner.
 */
export async function getOrCreateDirectConversation(
  userId: string,
  otherUserId: string,
): Promise<{ conversation: ConversationDocument; created: boolean }> {
  const directKey = directKeyFor([userId, otherUserId]);
  const existing = await Conversation.findOne({ directKey });
  if (existing) {
    return { conversation: existing, created: false };
  }

  try {
    const conversation = await Conversation.create({
      type: 'direct',
      participants: [userId, otherUserId],
      directKey,
    });
    return { conversation, created: true };
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const conversation = await Conversation.findOne({ directKey });
      if (conversation) {
        return { conversation, created: false };
      }
    }
    throw error;
  }
}

export async function createConversation(
  userId: string,
  input: CreateConversationInput,
): Promise<{ conversation: ConversationDto; created: boolean }> {
  const others = [...new Set(input.participantIds.map(String))].filter((id) => id !== userId);
  if (others.length === 0) {
    throw new HttpError(400, 'At least one other participant is required');
  }
  if (others.some((id) => !mongoose.isValidObjectId(id))) {
    throw new HttpError(400, 'Invalid participant id');
  }
  if (input.type === 'direct') {
    if (others.length !== 1) {
      throw new HttpError(400, 'Direct conversations require exactly one other participant');
    }
  } else if (input.type === 'group') {
    if (others.length < 2) {
      throw new HttpError(400, 'Group conversations require at least two other participants');
    }
  }

  const existingUsers = await User.countDocuments({ _id: { $in: others } });
  if (existingUsers !== others.length) {
    throw new HttpError(400, 'One or more participants do not exist');
  }

  const participantIds = [userId, ...others];
  let conversation: ConversationDocument;
  let created: boolean;

  if (input.type === 'direct') {
    const result = await getOrCreateDirectConversation(userId, others[0] as string);
    conversation = result.conversation;
    created = result.created;
  } else {
    conversation = await Conversation.create({
      type: 'group',
      participants: participantIds,
      name: input.name,
    });
    created = true;
  }

  await conversation.populate('participants', 'username displayName avatarUrl');
  return { conversation: toConversationDto(conversation), created };
}

export async function listConversations(userId: string): Promise<ConversationDto[]> {
  const conversations = await Conversation.find({ participants: userId })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(50)
    .populate('participants', 'username displayName avatarUrl');

  if (conversations.length === 0) {
    return [];
  }

  // One aggregation for every conversation the user belongs to. `recipients`
  // already excludes the sender, so own messages never count as unread; `$ne`
  // on the `readTo` array matches messages the user has not marked read.
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const rows = await Message.aggregate<UnreadCountRow>([
    {
      $match: {
        conversation: { $in: conversations.map((conversation) => conversation._id) },
        recipients: userObjectId,
        readTo: { $ne: userObjectId },
      },
    },
    { $group: { _id: '$conversation', count: { $sum: 1 } } },
  ]);
  const unreadByConversation = toUnreadCountMap(rows);

  return conversations.map((conversation) => ({
    ...toConversationDto(conversation),
    unreadCount: unreadByConversation.get(conversation.id as string) ?? 0,
  }));
}

export async function getConversationForMember(
  conversationId: string,
  userId: string,
): Promise<ConversationDocument> {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new HttpError(400, 'Invalid conversation id');
  }
  const conversation = await Conversation.findOne({
    _id: conversationId,
    participants: userId,
  });
  if (!conversation) {
    throw new HttpError(404, 'Conversation not found');
  }
  return conversation;
}

/** Participant ids if the user belongs to the conversation, otherwise null. */
export async function getParticipantIdsForMember(
  conversationId: string,
  userId: string,
): Promise<string[] | null> {
  if (!mongoose.isValidObjectId(conversationId)) {
    return null;
  }
  const conversation = await Conversation.findOne({
    _id: conversationId,
    participants: userId,
  }).select('participants');
  if (!conversation) {
    return null;
  }
  return conversation.participants.map((participant) => participant.toString());
}

/** Distinct user ids that share a conversation with the given user (for presence). */
export async function getContactIds(userId: string): Promise<string[]> {
  const conversations = await Conversation.find({ participants: userId }).select('participants');
  const ids = new Set<string>();
  for (const conversation of conversations) {
    for (const participant of conversation.participants) {
      const id = participant.toString();
      if (id !== userId) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/**
 * Loads a conversation the user belongs to and asserts it is a group, since
 * names/icons only apply to groups. Non-members get 404 (ids can't be probed),
 * direct conversations get 400.
 */
async function getGroupForMember(
  conversationId: string,
  userId: string,
  options: { withAvatarKey?: boolean } = {},
): Promise<ConversationDocument> {
  if (!mongoose.isValidObjectId(conversationId)) {
    throw new HttpError(400, 'Invalid conversation id');
  }
  const query = Conversation.findOne({ _id: conversationId, participants: userId });
  if (options.withAvatarKey) {
    query.select('+avatarKey');
  }
  const conversation = await query;
  if (!conversation) {
    throw new HttpError(404, 'Conversation not found');
  }
  if (conversation.type !== 'group') {
    throw new HttpError(400, 'Only group conversations can be edited');
  }
  return conversation;
}

async function populatedDto(conversation: ConversationDocument): Promise<ConversationDto> {
  await conversation.populate('participants', 'username displayName avatarUrl');
  return toConversationDto(conversation);
}

/** Renames a group. Any member may edit. */
export async function updateGroupName(
  userId: string,
  conversationId: string,
  input: UpdateGroupInput,
): Promise<ConversationDto> {
  const conversation = await getGroupForMember(conversationId, userId);
  conversation.name = input.name;
  await conversation.save();
  return populatedDto(conversation);
}

/** Sets or replaces a group's icon, deleting the previous object. */
export async function updateGroupAvatar(
  userId: string,
  conversationId: string,
  file: { buffer: Buffer; contentType: string },
): Promise<ConversationDto> {
  const extension = getFileExtension(file.contentType);
  if (!extension) {
    throw new HttpError(400, 'Unsupported image type');
  }

  const conversation = await getGroupForMember(conversationId, userId, { withAvatarKey: true });
  const previousKey = conversation.avatarKey;
  const key = `conversations/${conversation.id}/icon/${randomUUID()}${extension}`;
  const { url } = await storage.upload({ key, buffer: file.buffer, contentType: file.contentType });

  conversation.avatarUrl = url;
  conversation.avatarKey = key;
  await conversation.save();

  if (previousKey && previousKey !== key) {
    await storage.delete(previousKey).catch(() => undefined);
  }
  return populatedDto(conversation);
}

/**
 * Invites users to a group. Any member may invite. Invitees gain access to the
 * conversation's full history, because membership is what scopes message
 * access. Returns the updated conversation plus the ids that were actually
 * added, so the caller can emit `conversation:new` to them and
 * `conversation:updated` to the existing members.
 */
export async function addGroupParticipants(
  userId: string,
  conversationId: string,
  input: AddGroupMembersInput,
): Promise<{ conversation: ConversationDto; addedIds: string[] }> {
  const group = await getGroupForMember(conversationId, userId);

  const existing = new Set(group.participants.map((participant) => participant.toString()));
  const added = [...new Set(input.participantIds.map(String))].filter((id) => !existing.has(id));

  if (added.length === 0) {
    throw new HttpError(400, 'Everyone you selected is already in this group');
  }
  if (added.some((id) => !mongoose.isValidObjectId(id))) {
    throw new HttpError(400, 'Invalid participant id');
  }
  const existingUsers = await User.countDocuments({ _id: { $in: added } });
  if (existingUsers !== added.length) {
    throw new HttpError(400, 'One or more participants do not exist');
  }

  group.participants.push(...added.map((id) => new mongoose.Types.ObjectId(id)));
  await group.save();

  return { conversation: await populatedDto(group), addedIds: added };
}

/** Clears a group's icon. */
export async function removeGroupAvatar(
  userId: string,
  conversationId: string,
): Promise<ConversationDto> {
  const conversation = await getGroupForMember(conversationId, userId, { withAvatarKey: true });
  const previousKey = conversation.avatarKey;

  conversation.avatarUrl = undefined;
  conversation.avatarKey = undefined;
  await conversation.save();

  if (previousKey) {
    await storage.delete(previousKey).catch(() => undefined);
  }
  return populatedDto(conversation);
}
