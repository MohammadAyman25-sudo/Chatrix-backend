import { beforeEach, describe, expect, it } from 'vitest';
import {
  MESSAGE_NOTIFICATION_WINDOW_MS,
  MESSAGE_PREVIEW_MAX_LENGTH,
  buildMessagePreview,
  claimNotificationRecipients,
  queueNewMessageNotification,
  resetMessageNotifications,
} from './notification.service.js';
import { emailQueueSize } from './email.service.js';
import { registerSocket, unregisterSocket } from '../sockets/presence.js';

beforeEach(() => {
  resetMessageNotifications();
});

describe('buildMessagePreview', () => {
  it('returns trimmed text content as-is', () => {
    expect(buildMessagePreview({ type: 'text', content: '  hello there  ' })).toBe('hello there');
  });

  it('truncates long text to the max length with an ellipsis', () => {
    const preview = buildMessagePreview({ type: 'text', content: 'a'.repeat(500) });

    expect(preview.length).toBe(MESSAGE_PREVIEW_MAX_LENGTH);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('labels media messages that have no caption', () => {
    expect(buildMessagePreview({ type: 'image', content: '' })).toBe('📷 Photo');
    expect(buildMessagePreview({ type: 'video', content: '   ' })).toBe('🎥 Video');
    expect(buildMessagePreview({ type: 'audio', content: '' })).toBe('🎙️ Voice message');
    expect(buildMessagePreview({ type: 'file', content: '' })).toBe('📎 Attachment');
  });

  it('prefers a caption over the media label', () => {
    expect(buildMessagePreview({ type: 'image', content: 'sunset' })).toBe('sunset');
  });

  it('falls back to a generic label for empty text', () => {
    expect(buildMessagePreview({ type: 'text', content: '' })).toBe('Sent a message');
  });
});

describe('claimNotificationRecipients', () => {
  const now = 1_000_000;

  it('claims everyone the first time', () => {
    expect(claimNotificationRecipients(['a', 'b'], 'c1', now)).toEqual(['a', 'b']);
  });

  it('dedupes within the window', () => {
    claimNotificationRecipients(['a', 'b'], 'c1', now);
    expect(claimNotificationRecipients(['a', 'b'], 'c1', now + 1000)).toEqual([]);
  });

  it('only blocks a recipient for the conversation they were notified about', () => {
    claimNotificationRecipients(['a'], 'c1', now);
    expect(claimNotificationRecipients(['a'], 'c2', now + 1000)).toEqual(['a']);
  });

  it('re-claims after the window lapses', () => {
    claimNotificationRecipients(['a'], 'c1', now);
    expect(claimNotificationRecipients(['a'], 'c1', now + MESSAGE_NOTIFICATION_WINDOW_MS)).toEqual([
      'a',
    ]);
  });

  it('reset clears the dedupe state', () => {
    claimNotificationRecipients(['a'], 'c1', now);
    resetMessageNotifications();
    expect(claimNotificationRecipients(['a'], 'c1', now + 1)).toEqual(['a']);
  });
});

describe('queueNewMessageNotification', () => {
  it('does not enqueue an email when every recipient is online', () => {
    registerSocket('online-user', 'socket-1');
    try {
      queueNewMessageNotification({
        conversationId: 'c1',
        conversationType: 'direct',
        conversationName: null,
        senderName: 'Alice',
        messageType: 'text',
        messageContent: 'hi',
        recipientIds: ['online-user'],
      });

      expect(emailQueueSize()).toBe(0);
    } finally {
      unregisterSocket('online-user', 'socket-1');
    }
  });
});
