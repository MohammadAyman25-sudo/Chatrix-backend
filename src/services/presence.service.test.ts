import { describe, expect, it } from 'vitest';
import { toPresenceDto } from './presence.service.js';

describe('toPresenceDto', () => {
  it('reports online and hides last seen while connected', () => {
    expect(toPresenceDto('u1', new Date('2026-01-01T10:00:00.000Z'), true)).toEqual({
      userId: 'u1',
      status: 'online',
      lastSeenAt: null,
    });
  });

  it('reports offline with the stored last-seen timestamp', () => {
    expect(toPresenceDto('u1', new Date('2026-01-01T10:00:00.000Z'), false)).toEqual({
      userId: 'u1',
      status: 'offline',
      lastSeenAt: '2026-01-01T10:00:00.000Z',
    });
  });

  it('reports offline with a null last seen for a user never seen offline', () => {
    expect(toPresenceDto('u2', null, false)).toEqual({
      userId: 'u2',
      status: 'offline',
      lastSeenAt: null,
    });
  });
});
