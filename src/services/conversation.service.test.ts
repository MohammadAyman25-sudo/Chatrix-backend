import { describe, expect, it } from 'vitest';
import {
  addGroupMembersSchema,
  effectiveGroupOwner,
  toUnreadCountMap,
  updateGroupSchema,
} from './conversation.service.js';

describe('addGroupMembersSchema', () => {
  it('accepts a single id', () => {
    expect(addGroupMembersSchema.parse({ participantIds: ['u1'] })).toEqual({
      participantIds: ['u1'],
    });
  });

  it('accepts up to 50 ids', () => {
    const ids = Array.from({ length: 50 }, (_, index) => `u${index}`);
    expect(addGroupMembersSchema.safeParse({ participantIds: ids }).success).toBe(true);
  });

  it('rejects an empty list', () => {
    expect(addGroupMembersSchema.safeParse({ participantIds: [] }).success).toBe(false);
  });

  it('rejects more than 50 ids', () => {
    const ids = Array.from({ length: 51 }, (_, index) => `u${index}`);
    expect(addGroupMembersSchema.safeParse({ participantIds: ids }).success).toBe(false);
  });

  it('rejects a non-array payload', () => {
    expect(addGroupMembersSchema.safeParse({ participantIds: 'u1' }).success).toBe(false);
  });
});

describe('updateGroupSchema', () => {
  it('trims the group name', () => {
    expect(updateGroupSchema.parse({ name: '  Weekend Trip  ' })).toEqual({
      name: 'Weekend Trip',
    });
  });

  it('rejects an empty name', () => {
    expect(updateGroupSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects a name over 64 characters', () => {
    expect(updateGroupSchema.safeParse({ name: 'a'.repeat(65) }).success).toBe(false);
  });

  it('rejects a payload with no name', () => {
    expect(updateGroupSchema.safeParse({}).success).toBe(false);
  });
});

describe('toUnreadCountMap', () => {
  it('keys counts by conversation id', () => {
    const map = toUnreadCountMap([
      { _id: 'conversation-a', count: 3 },
      { _id: 'conversation-b', count: 1 },
    ]);

    expect(map.get('conversation-a')).toBe(3);
    expect(map.get('conversation-b')).toBe(1);
    expect(map.size).toBe(2);
  });

  it('stringifies ObjectId keys', () => {
    const id = '64f123abc456def789012347';
    const map = toUnreadCountMap([{ _id: id, count: 5 }]);

    expect(map.get(id)).toBe(5);
  });

  it('is empty when there are no rows', () => {
    expect(toUnreadCountMap([]).size).toBe(0);
  });
});

describe('effectiveGroupOwner', () => {
  it('returns the stored owner for a group', () => {
    expect(
      effectiveGroupOwner({
        type: 'group',
        owner: 'owner-1',
        participants: ['owner-1', 'member-2'],
      }),
    ).toBe('owner-1');
  });

  it('falls back to the first participant for legacy groups without an owner', () => {
    expect(
      effectiveGroupOwner({ type: 'group', participants: ['creator', 'member-2', 'member-3'] }),
    ).toBe('creator');
  });

  it('resolves populated participant docs in the legacy fallback', () => {
    expect(
      effectiveGroupOwner({
        type: 'group',
        participants: [{ _id: 'creator' }, { _id: 'member-2' }],
      }),
    ).toBe('creator');
  });

  it('is null for direct conversations, even with participants', () => {
    expect(effectiveGroupOwner({ type: 'direct', participants: ['a', 'b'] })).toBeNull();
  });

  it('is null when a group has no participants', () => {
    expect(effectiveGroupOwner({ type: 'group', participants: [] })).toBeNull();
  });
});
