import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Conversation } from '../models/conversation.model.js';
import type { ConversationDocument } from '../models/conversation.model.js';
import { User } from '../models/user.model.js';
import { HttpError } from '../middleware/error.middleware.js';

const createConversationSchema = z.object({
  participantIds: z.array(z.string()).min(1),
  type: z.enum(['direct', 'group']).default('direct'),
  name: z.string().trim().min(1).max(64).optional(),
});

interface PopulatedUser {
  _id: mongoose.Types.ObjectId;
  username: string;
  avatarUrl?: string;
}

function directKeyFor(userIds: string[]): string {
  return [...userIds].map(String).sort().join(':');
}

function toConversationDto(conversation: ConversationDocument) {
  const participants = conversation.participants as unknown as PopulatedUser[];
  return {
    id: conversation.id as string,
    type: conversation.type,
    name: conversation.name ?? null,
    participants: participants.map((participant) => ({
      id: participant._id.toString(),
      username: participant.username,
      avatarUrl: participant.avatarUrl ?? null,
    })),
    lastMessageAt: conversation.lastMessageAt ?? null,
    createdAt: conversation.createdAt,
  };
}

export async function createConversation(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }

  const data = createConversationSchema.parse(req.body);

  const others = [...new Set(data.participantIds.map(String))].filter((id) => id !== userId);
  if (others.length === 0) {
    throw new HttpError(400, 'At least one other participant is required');
  }
  if (others.some((id) => !mongoose.isValidObjectId(id))) {
    throw new HttpError(400, 'Invalid participant id');
  }
  if (data.type === 'direct' && others.length !== 1) {
    throw new HttpError(400, 'Direct conversations require exactly one other participant');
  }

  const existingUsers = await User.countDocuments({ _id: { $in: others } });
  if (existingUsers !== others.length) {
    throw new HttpError(400, 'One or more participants do not exist');
  }

  const participantIds = [userId, ...others];

  if (data.type === 'direct') {
    const directKey = directKeyFor(participantIds);
    let conversation = await Conversation.findOne({ directKey });
    if (!conversation) {
      conversation = await Conversation.create({
        type: 'direct',
        participants: participantIds,
        directKey,
      });
    }
    await conversation.populate('participants', 'username avatarUrl');
    res.status(200).json({ conversation: toConversationDto(conversation) });
    return;
  }

  const conversation = await Conversation.create({
    type: 'group',
    participants: participantIds,
    name: data.name,
  });
  await conversation.populate('participants', 'username avatarUrl');
  res.status(201).json({ conversation: toConversationDto(conversation) });
}

export async function listConversations(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }

  const conversations = await Conversation.find({ participants: userId })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(50)
    .populate('participants', 'username avatarUrl');

  res.json({ items: conversations.map(toConversationDto) });
}
