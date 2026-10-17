import type { Server, Socket } from 'socket.io';
import type { ConversationDto, MessageDto } from '../types/chat.js';

export interface SocketData {
  userId: string;
}

export interface AttachmentPayload {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
  key?: string;
  name: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface SendMessagePayload {
  conversationId: string;
  content?: string;
  clientTempId?: string;
  type?: 'text' | 'image' | 'video' | 'audio' | 'file';
  attachments?: AttachmentPayload[];
  replyToId?: string;
  /** Reply to the quoted message in a direct conversation with its author. */
  replyPrivately?: boolean;
}

export interface SendMessageAckResponse {
  ok: boolean;
  message?: MessageDto;
  clientTempId?: string;
  /** Present when a private reply created a new direct conversation. */
  conversation?: ConversationDto;
  error?: string;
}

export type SendMessageAck = (response: SendMessageAckResponse) => void;

export interface EditMessagePayload {
  conversationId: string;
  messageId: string;
  content: string;
}

export interface EditMessageAckResponse {
  ok: boolean;
  message?: MessageDto;
  error?: string;
}

export type EditMessageAck = (response: EditMessageAckResponse) => void;

export interface ForwardMessagePayload {
  conversationId: string;
  messageId: string;
  /** Existing conversations to forward the message into. */
  conversationIds?: string[];
  /** Users to forward the message to (their direct chat is found/created). */
  userIds?: string[];
}

export interface ForwardMessageAckResponse {
  ok: boolean;
  /** One copied message per target conversation. */
  messages?: MessageDto[];
  /** Direct conversations created for `userIds` targets, if any. */
  conversations?: ConversationDto[];
  error?: string;
}

export type ForwardMessageAck = (response: ForwardMessageAckResponse) => void;

export interface ConversationPayload {
  conversationId: string;
}

/**
 * Sent to a user the group owner removed from a group, so their client can
 * drop the chat immediately (they can no longer read its messages).
 */
export interface ConversationRemovedPayload {
  conversationId: string;
}

export interface TypingUpdatePayload {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

export interface MessageStatusPayload {
  conversationId: string;
  /** Who triggered the update (the recipient that received/read). */
  userId: string;
  status: 'delivered' | 'read';
  at: string;
}

export interface PresencePayload {
  userId: string;
  status: 'online' | 'offline';
  /**
   * When `status` is `offline`, the ISO timestamp of that disconnect. It is
   * `null` while online (clients render "online", not a last-seen time).
   */
  lastSeenAt: string | null;
}

export interface RecordingUpdatePayload {
  conversationId: string;
  userId: string;
  isRecording: boolean;
}

export interface ClientToServerEvents {
  'message:send': (payload: SendMessagePayload, ack: SendMessageAck) => void;
  'message:edit': (payload: EditMessagePayload, ack: EditMessageAck) => void;
  'message:forward': (payload: ForwardMessagePayload, ack: ForwardMessageAck) => void;
  'typing:start': (payload: ConversationPayload) => void;
  'typing:stop': (payload: ConversationPayload) => void;
  'recording:start': (payload: ConversationPayload) => void;
  'recording:stop': (payload: ConversationPayload) => void;
  'message:read': (payload: ConversationPayload) => void;
}

export interface ServerToClientEvents {
  'message:new': (message: MessageDto) => void;
  'message:edited': (message: MessageDto) => void;
  'conversation:new': (conversation: ConversationDto) => void;
  'conversation:updated': (conversation: ConversationDto) => void;
  'conversation:removed': (payload: ConversationRemovedPayload) => void;
  'typing:update': (payload: TypingUpdatePayload) => void;
  'recording:update': (payload: RecordingUpdatePayload) => void;
  'message:status': (payload: MessageStatusPayload) => void;
  'presence:update': (payload: PresencePayload) => void;
}

export type InterServerEvents = Record<string, never>;

export type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
