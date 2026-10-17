import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  MESSAGE_EDIT_WINDOW_MS,
  attachmentSchema,
  buildMessageInfo,
  computeMessageStatus,
  editMessageSchema,
  forwardMessageSchema,
  isWithinEditWindow,
  sendMessageSchema,
} from './message.service.js';
import type { MessageDocument } from '../models/message.model.js';
import type { ParticipantDto } from '../types/chat.js';

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

  it('caps a direct message at delivered when the reader has read receipts off', () => {
    expect(
      computeMessageStatus(
        message({ recipients: [recipientA], deliveredTo: [recipientA], readTo: [recipientA] }),
        { hiddenReadRecipients: new Set([recipientA.toString()]) },
      ),
    ).toBe('delivered');
  });

  it('treats a hidden reader with no delivery record as delivered (read implies delivered)', () => {
    expect(
      computeMessageStatus(message({ recipients: [recipientA], readTo: [recipientA] }), {
        hiddenReadRecipients: new Set([recipientA.toString()]),
      }),
    ).toBe('delivered');
  });

  it('does not leak a hidden reader in one conversation into another', () => {
    // `recipientB` has receipts off elsewhere; a message they have not read must
    // still be `sent` for recipientA.
    expect(
      computeMessageStatus(message({ recipients: [recipientA] }), {
        hiddenReadRecipients: new Set([recipientB.toString()]),
      }),
    ).toBe('sent');
  });

  it('ignores hidden read receipts once an unrelated group member has not read', () => {
    expect(
      computeMessageStatus(
        message({
          recipients: [recipientA, recipientB],
          deliveredTo: [recipientA, recipientB],
          readTo: [recipientA],
        }),
        { hiddenReadRecipients: new Set([recipientA.toString()]) },
      ),
    ).toBe('delivered');
  });
});

describe('buildMessageInfo', () => {
  function user(id: string, username = id): ParticipantDto {
    return { id, username, displayName: null, avatarUrl: null };
  }

  const alice = user('u-alice');
  const bob = user('u-bob');
  const carol = user('u-carol');
  const deliveredAt = new Date('2026-01-01T10:00:00.000Z');
  const readAt = new Date('2026-01-01T10:05:00.000Z');

  it('lists pending recipients that have neither received nor read', () => {
    const info = buildMessageInfo({
      conversationType: 'group',
      recipients: [alice, bob],
      deliveredTo: [alice.id],
      readTo: [],
      deliveredAt: new Map([[alice.id, deliveredAt]]),
    });

    expect(info.deliveredTo).toEqual([{ user: alice, at: deliveredAt }]);
    expect(info.readBy).toEqual([]);
    expect(info.pending).toEqual([bob]);
  });

  it('shows a direct recipient read time when their read receipts are on', () => {
    const info = buildMessageInfo({
      conversationType: 'direct',
      recipients: [bob],
      deliveredTo: [bob.id],
      readTo: [bob.id],
      deliveredAt: new Map([[bob.id, deliveredAt]]),
      readAt: new Map([[bob.id, readAt]]),
      readReceipts: new Map([[bob.id, true]]),
    });

    expect(info.readBy).toEqual([{ user: bob, at: readAt }]);
    expect(info.readReceiptsDisabled).toBe(false);
  });

  it('withholds a direct recipient read time when read receipts are off', () => {
    const info = buildMessageInfo({
      conversationType: 'direct',
      recipients: [bob],
      deliveredTo: [bob.id],
      readTo: [bob.id],
      readAt: new Map([[bob.id, readAt]]),
      readReceipts: new Map([[bob.id, false]]),
    });

    expect(info.readBy).toEqual([]);
    // Delivery is still revealed; no read time leaks.
    expect(info.deliveredTo).toEqual([{ user: bob, at: null }]);
    expect(info.pending).toEqual([]);
    expect(info.readReceiptsDisabled).toBe(true);
  });

  it('ignores read receipts off in a group and lists every reader', () => {
    const info = buildMessageInfo({
      conversationType: 'group',
      recipients: [alice, bob],
      deliveredTo: [alice.id, bob.id],
      readTo: [alice.id, bob.id],
      readAt: new Map([
        [alice.id, readAt],
        [bob.id, readAt],
      ]),
      readReceipts: new Map([
        [alice.id, false],
        [bob.id, true],
      ]),
    });

    expect(info.readBy.map((receipt) => receipt.user.id)).toEqual([alice.id, bob.id]);
    expect(info.readReceiptsDisabled).toBe(false);
  });

  it('treats a reader as delivered even if the delivered list lacks them', () => {
    const info = buildMessageInfo({
      conversationType: 'direct',
      recipients: [bob],
      deliveredTo: [],
      readTo: [bob.id],
      readAt: new Map([[bob.id, readAt]]),
      readReceipts: new Map([[bob.id, true]]),
    });

    expect(info.deliveredTo).toEqual([{ user: bob, at: readAt }]);
    expect(info.pending).toEqual([]);
  });

  it('returns null receipt times for messages stored before timestamps existed', () => {
    const info = buildMessageInfo({
      conversationType: 'group',
      recipients: [carol],
      deliveredTo: [carol.id],
      readTo: [carol.id],
    });

    expect(info.readBy).toEqual([{ user: carol, at: null }]);
    expect(info.deliveredTo).toEqual([{ user: carol, at: null }]);
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

  it('accepts a legacy app-relative (pre-R2) audio attachment with a duration', () => {
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
          url: 'https://pub-example.r2.dev/messages/c1/u1/clip.webm',
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
