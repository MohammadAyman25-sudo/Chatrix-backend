import { User } from '../models/user.model.js';
import type { MessageType } from '../models/message.model.js';
import type { ConversationType } from '../models/conversation.model.js';
import { isOnline } from '../sockets/presence.js';
import { conversationUrl, enqueueEmailJob, queueMessageNotification } from './email.service.js';

/** At most one notification email per recipient per conversation in this window. */
export const MESSAGE_NOTIFICATION_WINDOW_MS = 10 * 60 * 1000;

/** How much of a text message is shown in the email preview. */
export const MESSAGE_PREVIEW_MAX_LENGTH = 120;

/** `${userId}:${conversationId}` -> time of the last queued notification. */
const lastNotifiedAt = new Map<string, number>();

/**
 * Opportunistic cleanup so a long-lived process does not keep every
 * user/conversation pair forever (mirrors `utils/rateLimiter.ts`).
 */
const MAX_ENTRIES = 10_000;

function prune(now: number): void {
  if (lastNotifiedAt.size < MAX_ENTRIES) {
    return;
  }
  for (const [key, at] of lastNotifiedAt) {
    if (now - at >= MESSAGE_NOTIFICATION_WINDOW_MS) {
      lastNotifiedAt.delete(key);
    }
  }
}

/** Clears the dedupe map (test helper). */
export function resetMessageNotifications(): void {
  lastNotifiedAt.clear();
}

/**
 * Records a notification for `userIds` in `conversationId` and returns only the
 * users who have not been notified about that conversation within the window.
 * Claiming happens synchronously at enqueue time so a burst of messages does not
 * pile up — the first one wins and the rest are dropped until the window lapses.
 */
export function claimNotificationRecipients(
  userIds: string[],
  conversationId: string,
  now = Date.now(),
): string[] {
  const claimed: string[] = [];
  for (const userId of userIds) {
    const key = `${userId}:${conversationId}`;
    const last = lastNotifiedAt.get(key);
    if (last !== undefined && now - last < MESSAGE_NOTIFICATION_WINDOW_MS) {
      continue;
    }
    lastNotifiedAt.set(key, now);
    claimed.push(userId);
  }
  prune(now);
  return claimed;
}

const ATTACHMENT_PREVIEWS: Record<Exclude<MessageType, 'text'>, string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎙️ Voice message',
  file: '📎 Attachment',
};

/**
 * Short, human-readable preview for a notification email. Text (or captioned)
 * messages show a truncated excerpt; media-only messages show a label instead of
 * an empty body.
 */
export function buildMessagePreview(message: { type: MessageType; content?: string }): string {
  const content = (message.content ?? '').trim();
  if (content) {
    return content.length <= MESSAGE_PREVIEW_MAX_LENGTH
      ? content
      : `${content.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return ATTACHMENT_PREVIEWS[message.type as Exclude<MessageType, 'text'>] ?? 'Sent a message';
}

export interface NewMessageNotificationInput {
  conversationId: string;
  conversationType: ConversationType;
  /** Group name; ignored for direct conversations (the sender's name is used). */
  conversationName?: string | null;
  /** Display name (or username) of the sender. */
  senderName: string;
  messageType: MessageType;
  messageContent?: string;
  /** Participants minus the sender. Only the offline ones are emailed. */
  recipientIds: string[];
}

/** Everything the delivery job needs, resolved up front. */
interface NotificationDelivery {
  recipientIds: string[];
  senderName: string;
  conversationLabel: string;
  preview: string;
  url: string;
  isGroup: boolean;
}

/**
 * Decides who to email about a new message and enqueues the delivery job. Does
 * no I/O and never blocks the send path; returns early when nobody is offline or
 * the conversation was notified recently. Only offline recipients are emailed —
 * online users already receive `message:new` over the socket.
 */
export function queueNewMessageNotification(input: NewMessageNotificationInput): void {
  const offline = input.recipientIds.filter((id) => !isOnline(id));
  if (offline.length === 0) {
    return;
  }
  const claimed = claimNotificationRecipients(offline, input.conversationId);
  if (claimed.length === 0) {
    return;
  }

  const isGroup = input.conversationType === 'group';
  const delivery: NotificationDelivery = {
    recipientIds: claimed,
    senderName: input.senderName,
    conversationLabel: isGroup ? input.conversationName?.trim() || 'a group' : input.senderName,
    preview: buildMessagePreview({ type: input.messageType, content: input.messageContent }),
    url: conversationUrl(input.conversationId),
    isGroup,
  };

  enqueueEmailJob(`message-notification:${input.conversationId}`, () =>
    deliverMessageNotifications(delivery),
  );
}

/**
 * Loads the recipients' email addresses (honouring `settings.notifications`)
 * and queues one email per recipient, so a single bad address cannot block the
 * rest.
 */
async function deliverMessageNotifications(delivery: NotificationDelivery): Promise<void> {
  const users = await User.find({
    _id: { $in: delivery.recipientIds },
    'settings.notifications': { $ne: false },
  }).select('username displayName email');

  for (const user of users) {
    queueMessageNotification({
      to: user.email,
      recipientName: user.displayName ?? user.username,
      senderName: delivery.senderName,
      conversationLabel: delivery.conversationLabel,
      preview: delivery.preview,
      url: delivery.url,
      isGroup: delivery.isGroup,
    });
  }
}
