import type { Request, Response } from 'express';
import { HttpError } from '../middleware/error.middleware.js';
import {
  addGroupMembersSchema,
  addGroupParticipants,
  createConversation,
  createConversationSchema,
  getParticipantIdsForMember,
  listConversations,
  removeGroupAvatar,
  updateGroupAvatar,
  updateGroupName,
  updateGroupSchema,
} from '../services/conversation.service.js';
import { getPresenceForUsers } from '../services/presence.service.js';
import { emitConversationNew, emitConversationUpdated } from '../sockets/emitters.js';
import { routeParam } from '../utils/routeParam.js';

function requireUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }
  return userId;
}

export async function createConversationHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);

  const data = createConversationSchema.parse(req.body);
  const { conversation, created } = await createConversation(userId, data);

  emitConversationNew(
    conversation.participants.map((participant) => participant.id),
    conversation,
    userId,
  );

  res.status(created ? 201 : 200).json({ conversation });
}

export async function listConversationsHandler(req: Request, res: Response): Promise<void> {
  const items = await listConversations(requireUserId(req));
  res.json({ items });
}

function broadcastConversationUpdate(
  conversation: Parameters<typeof emitConversationUpdated>[1],
  actorId: string,
): void {
  emitConversationUpdated(
    conversation.participants.map((participant) => participant.id),
    conversation,
    actorId,
  );
}

/** Renames a group (any member). Emits `conversation:updated` to the others. */
export async function updateGroupHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const input = updateGroupSchema.parse(req.body);
  const conversation = await updateGroupName(userId, routeParam(req.params.conversationId), input);

  broadcastConversationUpdate(conversation, userId);
  res.json({ conversation });
}

/** Sets or replaces a group icon (any member). Multipart field `avatar`. */
export async function updateGroupAvatarHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  if (!req.file) {
    throw new HttpError(400, 'No icon file provided (expected multipart field "avatar")');
  }

  const conversation = await updateGroupAvatar(userId, routeParam(req.params.conversationId), {
    buffer: req.file.buffer,
    contentType: req.file.mimetype,
  });

  broadcastConversationUpdate(conversation, userId);
  res.json({ conversation });
}

export async function deleteGroupAvatarHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const conversation = await removeGroupAvatar(userId, routeParam(req.params.conversationId));

  broadcastConversationUpdate(conversation, userId);
  res.json({ conversation });
}

/**
 * Invites users to a group. Invitees receive `conversation:new` (from their
 * point of view it is a new chat); existing members get `conversation:updated`.
 */
export async function addGroupParticipantsHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const input = addGroupMembersSchema.parse(req.body);
  const { conversation, addedIds } = await addGroupParticipants(
    userId,
    routeParam(req.params.conversationId),
    input,
  );

  const added = new Set(addedIds);
  const existingIds = conversation.participants
    .map((participant) => participant.id)
    .filter((id) => !added.has(id));

  emitConversationUpdated(existingIds, conversation, userId);
  emitConversationNew(addedIds, conversation, userId);
  res.json({ conversation });
}

/**
 * Live online/last-seen for everyone in a conversation. Used when a chat opens
 * so the client does not have to wait for the next `presence:update`. Members
 * only: non-members get 404 so conversation ids cannot be probed.
 */
export async function getConversationPresenceHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const conversationId = routeParam(req.params.conversationId);

  const participants = await getParticipantIdsForMember(conversationId, userId);
  if (!participants) {
    throw new HttpError(404, 'Conversation not found');
  }

  const items = await getPresenceForUsers(participants);
  res.json({ items });
}
