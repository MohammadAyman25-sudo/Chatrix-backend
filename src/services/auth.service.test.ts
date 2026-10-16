import { describe, expect, it } from 'vitest';
import { registerSchema, toPublicUser } from './auth.service.js';
import type { UserDocument } from '../models/user.model.js';

const validInput = {
  username: 'alice',
  email: 'alice@example.com',
  password: 'Str0ng!Pass',
  confirmPassword: 'Str0ng!Pass',
};

describe('registerSchema', () => {
  it('accepts a valid registration and drops confirmPassword', () => {
    const result = registerSchema.parse(validInput);

    expect(result).toEqual({
      username: 'alice',
      email: 'alice@example.com',
      password: 'Str0ng!Pass',
    });
    expect(result).not.toHaveProperty('confirmPassword');
  });

  it('rejects mismatched passwords', () => {
    const result = registerSchema.safeParse({ ...validInput, confirmPassword: 'Different1!' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.includes('confirmPassword') && /do not match/i.test(issue.message),
        ),
      ).toBe(true);
    }
  });

  it('rejects a password that does not meet the policy', () => {
    const result = registerSchema.safeParse({
      ...validInput,
      password: 'weak',
      confirmPassword: 'weak',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const passwordIssues = result.error.issues.filter((issue) => issue.path.includes('password'));
      expect(passwordIssues.length).toBeGreaterThan(0);
    }
  });

  it('requires an uppercase letter, number and symbol', () => {
    const result = registerSchema.safeParse({
      username: 'alice',
      email: 'alice@example.com',
      password: 'lowercaseonly',
      confirmPassword: 'lowercaseonly',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(' ');
      expect(messages).toMatch(/uppercase/i);
      expect(messages).toMatch(/number/i);
      expect(messages).toMatch(/special symbol/i);
    }
  });
});

function userDocument(emailVerifiedAt: Date | undefined): UserDocument {
  return {
    id: '64f123abc456def789012345',
    username: 'alice',
    email: 'alice@example.com',
    emailVerifiedAt,
    displayName: 'Alice',
    bio: undefined,
    avatarUrl: undefined,
    settings: undefined,
    createdAt: new Date('2025-10-14T12:00:00.000Z'),
  } as unknown as UserDocument;
}

describe('toPublicUser', () => {
  it('reports emailVerified false for a new, unverified account', () => {
    expect(toPublicUser(userDocument(undefined)).emailVerified).toBe(false);
  });

  it('reports emailVerified true once the address is confirmed', () => {
    expect(toPublicUser(userDocument(new Date())).emailVerified).toBe(true);
  });
});
