import { describe, expect, it } from 'vitest';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './token.js';

describe('token utilities', () => {
  it('round-trips an access token', () => {
    const token = signAccessToken('user-1');
    expect(verifyAccessToken(token)).toMatchObject({ sub: 'user-1', tokenType: 'access' });
  });

  it('round-trips a refresh token', () => {
    const token = signRefreshToken('user-2');
    expect(verifyRefreshToken(token)).toMatchObject({ sub: 'user-2', tokenType: 'refresh' });
  });

  it('rejects a malformed token', () => {
    expect(() => verifyAccessToken('not-a-token')).toThrow();
  });
});
