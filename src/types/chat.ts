import type { ConversationType } from '../models/conversation.model.js';
import type { MessageStatus } from '../models/message.model.js';
import type { ThemePreference } from '../models/user.model.js';

export type { MessageStatus, MessageType, IAttachment } from '../models/message.model.js';
export type { ThemePreference } from '../models/user.model.js';

export interface UserSettings {
  theme: ThemePreference;
  notifications: boolean;
  readReceipts: boolean;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  /** False until the owner clicks the emailed verification link. */
  emailVerified: boolean;
  bio: string | null;
  avatarUrl: string | null;
  settings: UserSettings;
  createdAt: Date;
}

export interface ParticipantDto {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Another user's publicly visible profile. Deliberately excludes `email` and
 * `settings`, which are only ever returned to their owner via `/users/me`.
 */
export interface PublicProfile {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

export type PresenceStatus = 'online' | 'offline';

/**
 * A participant's live presence. `status` comes from the in-memory socket
 * registry; `lastSeenAt` is the stored timestamp of their most recent
 * disconnect (null while they are online or have never gone offline).
 */
export interface PresenceDto {
  userId: string;
  status: PresenceStatus;
  lastSeenAt: string | null;
}

export interface ConversationDto {
  id: string;
  type: ConversationType;
  name: string | null;
  /** Group icon; always null for direct conversations (use participant avatars). */
  avatarUrl: string | null;
  participants: ParticipantDto[];
  lastMessageAt: Date | null;
  createdAt: Date;
  /**
   * How many messages the requesting user has not read yet. Only included by
   * `GET /conversations` (the canonical sidebar list), where it is always
   * present. Realtime `conversation:new` / `conversation:updated` payloads omit
   * it, so clients keep the count locally: increment on `message:new` and reset
   * when the conversation is opened (which sends `message:read`).
   */
  unreadCount?: number;
}

export interface AttachmentDto {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
  name: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface ReplyToDto {
  id: string;
  content: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  attachments: AttachmentDto[];
  sender: ParticipantDto;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  content: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  attachments: AttachmentDto[];
  sender: ParticipantDto;
  replyTo?: ReplyToDto;
  status: MessageStatus;
  /** When the sender last edited the content, or null if never edited. */
  editedAt: Date | null;
  /** True when the message was forwarded from another chat ("Forwarded" label). */
  forwarded: boolean;
  createdAt: Date;
}
