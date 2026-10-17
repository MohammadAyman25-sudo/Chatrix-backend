import { getIO } from './io.js';
import type { ConversationDto, MessageDto } from '../types/chat.js';
import type {
  MessageStatusPayload,
  PresencePayload,
  RecordingUpdatePayload,
  TypingUpdatePayload,
} from './types.js';

function roomsFor(userIds: string[], exceptUserId?: string): string[] {
  return userIds.filter((id) => id !== exceptUserId).map((id) => `user:${id}`);
}

export function emitNewMessage(
  participantIds: string[],
  message: MessageDto,
  exceptUserId?: string,
): void {
  getIO()?.to(roomsFor(participantIds, exceptUserId)).emit('message:new', message);
}

export function emitMessageEdited(
  participantIds: string[],
  message: MessageDto,
  exceptUserId?: string,
): void {
  getIO()?.to(roomsFor(participantIds, exceptUserId)).emit('message:edited', message);
}

export function emitConversationNew(
  participantIds: string[],
  conversation: ConversationDto,
  exceptUserId?: string,
): void {
  getIO()?.to(roomsFor(participantIds, exceptUserId)).emit('conversation:new', conversation);
}

export function emitConversationUpdated(
  participantIds: string[],
  conversation: ConversationDto,
  exceptUserId?: string,
): void {
  getIO()?.to(roomsFor(participantIds, exceptUserId)).emit('conversation:updated', conversation);
}

/** Tells a removed member to drop a conversation from their client. */
export function emitConversationRemoved(conversationId: string, userId: string): void {
  getIO()?.to(`user:${userId}`).emit('conversation:removed', { conversationId });
}

/**
 * Broadcasts the result of a forward: any newly created direct conversations
 * first (so recipients can resolve the chat), then one `message:new` per target
 * conversation. The sender is excluded (they get the result via response/ack).
 */
export function emitForwardedMessages(
  deliveries: Array<{ participantIds: string[]; message: MessageDto }>,
  createdConversations: ConversationDto[],
  senderId: string,
): void {
  for (const conversation of createdConversations) {
    emitConversationNew(
      conversation.participants.map((participant) => participant.id),
      conversation,
      senderId,
    );
  }
  for (const { participantIds, message } of deliveries) {
    emitNewMessage(participantIds, message, senderId);
  }
}

export function emitTyping(
  participantIds: string[],
  payload: TypingUpdatePayload,
  exceptUserId?: string,
): void {
  getIO()?.to(roomsFor(participantIds, exceptUserId)).emit('typing:update', payload);
}

export function emitRecording(
  participantIds: string[],
  payload: RecordingUpdatePayload,
  exceptUserId?: string,
): void {
  getIO()?.to(roomsFor(participantIds, exceptUserId)).emit('recording:update', payload);
}

export function emitMessageStatus(
  participantIds: string[],
  payload: MessageStatusPayload,
  exceptUserId?: string,
): void {
  getIO()?.to(roomsFor(participantIds, exceptUserId)).emit('message:status', payload);
}

export function emitPresence(
  userIds: string[],
  payload: PresencePayload,
  exceptUserId?: string,
): void {
  getIO()?.to(roomsFor(userIds, exceptUserId)).emit('presence:update', payload);
}
