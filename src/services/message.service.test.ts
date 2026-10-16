import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  MESSAGE_EDIT_WINDOW_MS,
  attachmentSchema,
  computeMessageStatus,
  editMessageSchema,
  forwardMessageSchema,
  isWithinEditWindow,
  sendMessageSchema,
} from './message.service.js';
import type { MessageDocument } from '../models/message.model.js';

const recipientA = new mongoose.Types.ObjectId();
const recipientB = new mongoose.Types.ObjectId();

function message(overrides: Partial<Record<'recipients' | 'deliveredTo' | 'readTo', unknown>>) {
  return {
    recipients: [],
    deliveredTo: [],
    readTo: [],
    ...overrides,
  } as unknown as MessageDocument;
}

describe('computeMessageStatus', () => {
  it('treats messages with no recipients as read', () => {
    expect(computeMessageStatus(message({}))).toBe('read');
  });

  it('is sent when nobody has received it yet', () => {
    expect(computeMessageStatus(message({ recipients: [recipientA] }))).toBe('sent');
  });

  it('is delivered once every recipient received it', () => {
    expect(
      computeMessageStatus(message({ recipients: [recipientA], deliveredTo: [recipientA] })),
    ).toBe('delivered');
  });

  it('is read once every recipient read it', () => {
    expect(
      computeMessageStatus(
        message({ recipients: [recipientA, recipientB], readTo: [recipientA, recipientB] }),
      ),
    ).toBe('read');
  });

  it('stays delivered until all recipients in a group have read', () => {
    expect(
      computeMessageStatus(
        message({
          recipients: [recipientA, recipientB],
          deliveredTo: [recipientA, recipientB],
          readTo: [recipientA],
        }),
      ),
    ).toBe('delivered');
  });
});

describe('attachmentSchema', () => {
  const voiceNote = {
    type: 'audio' as const,
    url: '/uploads/messages/c1/u1/clip.webm',
    name: 'voice-note.webm',
    size: 1024,
    mimeType: 'audio/webm',
    duration: 7,
  };

  it('accepts a local-disk (relative path) audio attachment with a duration', () => {
    expect(attachmentSchema.parse(voiceNote)).toEqual(voiceNote);
  });

  it('accepts an absolute object-storage url', () => {
    const remote = { ...voiceNote, url: 'https://cdn.example.com/messages/clip.webm' };
    expect(attachmentSchema.safeParse(remote).success).toBe(true);
  });

  it('rejects an attachment with an invalid url', () => {
    expect(attachmentSchema.safeParse({ ...voiceNote, url: 'not a url' }).success).toBe(false);
  });
});

describe('sendMessageSchema', () => {
  it('accepts a voice note sent with no text content', () => {
    const result = sendMessageSchema.safeParse({
      conversationId: 'c1',
      type: 'audio',
      attachments: [
        {
          type: 'audio',
          url: '/uploads/messages/c1/u1/clip.webm',
          name: 'voice-note.webm',
          size: 2048,
          mimeType: 'audio/webm',
          duration: 12,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a message with neither content nor attachments', () => {
    const result = sendMessageSchema.safeParse({ conversationId: 'c1' });
    expect(result.success).toBe(false);
  });

  it('defaults replyPrivately to false', () => {
    const result = sendMessageSchema.parse({ conversationId: 'c1', content: 'hi' });
    expect(result.replyPrivately).toBe(false);
  });

  it('accepts replyPrivately alongside replyToId', () => {
    const result = sendMessageSchema.safeParse({
      conversationId: 'c1',
      content: 'psst',
      replyToId: 'm1',
      replyPrivately: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replyPrivately).toBe(true);
    }
  });
});

describe('editMessageSchema', () => {
  it('trims content and accepts a normal edit', () => {
    expect(editMessageSchema.parse({ content: '  fixed typo  ' })).toEqual({
      content: 'fixed typo',
    });
  });

  it('rejects empty/whitespace-only content', () => {
    expect(editMessageSchema.safeParse({ content: '   ' }).success).toBe(false);
  });

  it('rejects content over 4000 characters', () => {
    expect(editMessageSchema.safeParse({ content: 'a'.repeat(4001) }).success).toBe(false);
  });
});

describe('forwardMessageSchema', () => {
  it('accepts forwarding to a single conversation', () => {
    expect(forwardMessageSchema.parse({ conversationIds: ['c1'] })).toEqual({
      conversationIds: ['c1'],
      userIds: [],
    });
  });

  it('accepts forwarding to users only', () => {
    const result = forwardMessageSchema.parse({ userIds: ['u2', 'u3'] });
    expect(result.userIds).toEqual(['u2', 'u3']);
    expect(result.conversationIds).toEqual([]);
  });

  it('accepts conversations and users together', () => {
    expect(
      forwardMessageSchema.safeParse({ conversationIds: ['c1'], userIds: ['u2'] }).success,
    ).toBe(true);
  });

  it('rejects a forward with no targets', () => {
    expect(forwardMessageSchema.safeParse({}).success).toBe(false);
    expect(forwardMessageSchema.safeParse({ conversationIds: [], userIds: [] }).success).toBe(
      false,
    );
  });

  it('rejects more than 20 targets of one kind', () => {
    const ids = Array.from({ length: 21 }, (_, index) => `c${index}`);
    expect(forwardMessageSchema.safeParse({ conversationIds: ids }).success).toBe(false);
  });
});

describe('isWithinEditWindow', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');

  it('allows editing a message sent just now', () => {
    expect(isWithinEditWindow(now, now)).toBe(true);
  });

  it('allows editing a message sent within the window', () => {
    const sentAt = new Date(now.getTime() - (MESSAGE_EDIT_WINDOW_MS - 1000));
    expect(isWithinEditWindow(sentAt, now)).toBe(true);
  });

  it('rejects editing a message sent before the window', () => {
    const sentAt = new Date(now.getTime() - (MESSAGE_EDIT_WINDOW_MS + 1000));
    expect(isWithinEditWindow(sentAt, now)).toBe(false);
  });
});
