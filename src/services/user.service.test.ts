import { describe, expect, it } from 'vitest';
import { escapeRegex, searchUsersSchema, toPublicProfile } from './user.service.js';
import type { UserDocument } from '../models/user.model.js';

describe('escapeRegex', () => {
  it('escapes regex metacharacters so search input is treated literally', () => {
    expect(escapeRegex('a.*+?^${}()|[]\\b')).toBe('a\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\b');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeRegex('alice')).toBe('alice');
  });
});

describe('searchUsersSchema', () => {
  it('trims the query and applies a default limit', () => {
    expect(searchUsersSchema.parse({ q: '  alice  ' })).toEqual({ q: 'alice', limit: 20 });
  });

  it('rejects empty or whitespace-only queries', () => {
    expect(searchUsersSchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(searchUsersSchema.safeParse({}).success).toBe(false);
  });

  it('coerces and caps the limit', () => {
    expect(searchUsersSchema.parse({ q: 'a', limit: '5' }).limit).toBe(5);
    expect(searchUsersSchema.safeParse({ q: 'a', limit: '100' }).success).toBe(false);
  });
});

describe('toPublicProfile', () => {
  it('exposes only public fields and never leaks email or settings', () => {
    const document = {
      id: '64f123abc456def789012345',
      username: 'alice',
      displayName: 'Alice',
      bio: 'hi',
      avatarUrl: null,
      email: 'alice@example.com',
      settings: { theme: 'dark', notifications: false, readReceipts: false },
      password: 'hashed',
    } as unknown as UserDocument;

    const profile = toPublicProfile(document);

    expect(profile).toEqual({
      id: '64f123abc456def789012345',
      username: 'alice',
      displayName: 'Alice',
      bio: 'hi',
      avatarUrl: null,
    });
    expect(Object.keys(profile)).not.toContain('email');
    expect(Object.keys(profile)).not.toContain('settings');
    expect(Object.keys(profile)).not.toContain('password');
  });

  it('normalizes missing optional fields to null', () => {
    const document = {
      id: 'abc',
      username: 'bob',
    } as unknown as UserDocument;

    expect(toPublicProfile(document)).toEqual({
      id: 'abc',
      username: 'bob',
      displayName: null,
      bio: null,
      avatarUrl: null,
    });
  });
});
