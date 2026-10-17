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
  /**
   * The group owner — the only member allowed to remove others. Always null
   * for direct conversations. Groups created before ownership was stored fall
   * back to their first participant (the creator).
   */
  ownerId: string | null;
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

/**
 * One recipient's delivery or read receipt for the "Message info" screen.
 * `at` is null for messages stored before receipt timestamps existed.
 */
export interface MessageReceiptDto {
  user: ParticipantDto;
  at: Date | null;
}

/**
 * Per-message delivery/read detail for its **sender** (`GET
 * /conversations/:id/messages/:messageId/info`). In a **direct** conversation a
 * recipient's read time is only revealed when their `settings.readReceipts` is
 * on (`readReceiptsDisabled` flags that it is off); in a **group** the setting
 * is ignored and every member's delivery/read times are shown.
 */
export interface MessageInfoDto {
  messageId: string;
  conversationId: string;
  conversationType: ConversationType;
  /** Aggregate status from the sender's perspective. */
  status: MessageStatus;
  /** Recipients the message has reached, with the delivery time. */
  deliveredTo: MessageReceiptDto[];
  /**
   * Recipients who read the message, with the read time. In a direct chat this
   * omits the other member when they have read receipts disabled.
   */
  readBy: MessageReceiptDto[];
  /** Recipients who have neither received nor read the message yet. */
  pending: ParticipantDto[];
  /**
   * Direct conversations only: true when the other member has read receipts
   * turned off, so their read time is intentionally withheld. Always false for
   * groups, where receipts are always shown.
   */
  readReceiptsDisabled: boolean;
}

/**
 * A message returned by `GET /messages/search`, together with the conversation
 * it belongs to so the client can render the chat title (a direct conversation
 * has no name, hence the full participant list).
 */
export interface MessageSearchHit extends MessageDto {
  conversation: ConversationDto;
}

/**
 * A message returned by the conversation media listing (`GET
 * /conversations/:id/media`): the message plus the URLs found in its content
 * (`[]` when it has none), so a "links" tab needs no client-side parsing.
 */
export interface ConversationMediaItem extends MessageDto {
  links: string[];
}
