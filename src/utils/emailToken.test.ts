import { describe, expect, it } from 'vitest';
import { EMAIL_TOKEN_BYTES, generateEmailToken, hashEmailToken } from './emailToken.js';

describe('generateEmailToken', () => {
  it('returns a token whose hash is the sha256 of that token', () => {
    const { token, hash } = generateEmailToken();

    expect(hash).toBe(hashEmailToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a URL-safe token with full entropy', () => {
    const { token } = generateEmailToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url-encoded is 43 characters.
    expect(token).toHaveLength(43);
  });

  it('produces a unique token each time', () => {
    const first = generateEmailToken();
    const second = generateEmailToken();

    expect(first.token).not.toBe(second.token);
    expect(first.hash).not.toBe(second.hash);
  });
});

describe('hashEmailToken', () => {
  it('is deterministic', () => {
    expect(hashEmailToken('abc')).toBe(hashEmailToken('abc'));
  });

  it('matches a known sha256 digest', () => {
    expect(hashEmailToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('EMAIL_TOKEN_BYTES', () => {
  it('carries 256 bits of entropy', () => {
    expect(EMAIL_TOKEN_BYTES).toBe(32);
  });
});
