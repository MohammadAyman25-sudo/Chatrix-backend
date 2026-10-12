import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor utilities', () => {
  it('round-trips a valid ObjectId', () => {
    const id = '652f1a2b3c4d5e6f7890abcd';
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it('rejects a cursor that does not decode to an ObjectId', () => {
    const cursor = Buffer.from('not-an-object-id', 'utf8').toString('base64url');
    expect(() => decodeCursor(cursor)).toThrow();
  });
});
