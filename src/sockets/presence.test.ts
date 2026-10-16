import { describe, expect, it } from 'vitest';
import { isOnline, registerSocket, unregisterSocket } from './presence.js';

describe('presence tracking', () => {
  it('reports online once and offline after the last socket leaves', () => {
    expect(registerSocket('u1', 's1')).toBe(true);
    expect(registerSocket('u1', 's2')).toBe(false);
    expect(isOnline('u1')).toBe(true);

    expect(unregisterSocket('u1', 's1')).toBe(false);
    expect(isOnline('u1')).toBe(true);

    expect(unregisterSocket('u1', 's2')).toBe(true);
    expect(isOnline('u1')).toBe(false);
  });
});
