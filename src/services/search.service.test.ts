import { describe, expect, it } from 'vitest';
import { searchMessagesSchema, searchTokens } from './search.service.js';

describe('searchMessagesSchema', () => {
  it('trims the query and applies defaults', () => {
    expect(searchMessagesSchema.parse({ q: '  hello  ' })).toEqual({ q: 'hello', limit: 20 });
  });

  it('coerces and validates pagination input', () => {
    expect(searchMessagesSchema.parse({ q: 'hi', limit: '5', cursor: 'abc' })).toEqual({
      q: 'hi',
      limit: 5,
      cursor: 'abc',
    });
    expect(() => searchMessagesSchema.parse({ q: 'hi', limit: 0 })).toThrow();
    expect(() => searchMessagesSchema.parse({ q: 'hi', limit: 51 })).toThrow();
  });

  it('rejects empty and over-long queries', () => {
    expect(() => searchMessagesSchema.parse({ q: '   ' })).toThrow();
    expect(() => searchMessagesSchema.parse({ q: 'a'.repeat(101) })).toThrow();
    expect(() => searchMessagesSchema.parse({})).toThrow();
  });
});

describe('searchTokens', () => {
  it('normalizes and splits the query into AND tokens', () => {
    expect(searchTokens('Hello   WORLD')).toEqual(['hello', 'world']);
    expect(searchTokens('مرحباً بالعالم')).toEqual(['مرحبا', 'بالعالم']);
    expect(searchTokens('أ')).toEqual(['ا']);
    expect(searchTokens('٢٠٢٤')).toEqual(['2024']);
  });

  it('returns no tokens when nothing searchable remains', () => {
    expect(searchTokens('!!! 😊')).toEqual([]);
    expect(searchTokens('   ')).toEqual([]);
  });
});
