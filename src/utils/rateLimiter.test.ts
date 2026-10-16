import { beforeEach, describe, expect, it } from 'vitest';
import { consume, resetRateLimiter } from './rateLimiter.js';

describe('consume', () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  it('allows up to the limit then blocks', () => {
    expect(consume('user:1', 2, 1000, 0)).toBe(true);
    expect(consume('user:1', 2, 1000, 1)).toBe(true);
    expect(consume('user:1', 2, 1000, 2)).toBe(false);
  });

  it('tracks keys independently', () => {
    expect(consume('a', 1, 1000, 0)).toBe(true);
    expect(consume('b', 1, 1000, 0)).toBe(true);
  });

  it('resets once the window elapses', () => {
    expect(consume('user:1', 1, 1000, 0)).toBe(true);
    expect(consume('user:1', 1, 1000, 500)).toBe(false);
    expect(consume('user:1', 1, 1000, 1000)).toBe(true);
  });
});
