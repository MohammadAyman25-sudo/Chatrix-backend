import { describe, expect, it } from 'vitest';
import { extractLinks } from './links.js';

describe('extractLinks', () => {
  it('finds http(s) and www links in order', () => {
    expect(extractLinks('see https://example.com/a and www.example.org then http://x.io')).toEqual([
      'https://example.com/a',
      'www.example.org',
      'http://x.io',
    ]);
  });

  it('trims trailing sentence punctuation', () => {
    expect(extractLinks('check https://example.com/page, then this')).toEqual([
      'https://example.com/page',
    ]);
    expect(extractLinks('read it: https://example.com/.')).toEqual(['https://example.com/']);
    expect(extractLinks('“https://example.com”')).toEqual(['https://example.com']);
  });

  it('keeps balanced brackets and drops trailing ones', () => {
    expect(extractLinks('(https://x.com/a(b)) done')).toEqual(['https://x.com/a(b)']);
    expect(extractLinks('https://en.wikipedia.org/wiki/A_(b)')).toEqual([
      'https://en.wikipedia.org/wiki/A_(b)',
    ]);
  });

  it('ignores other schemes and bare emails', () => {
    expect(extractLinks('mailto:a@b.com tel:+123 ftp://x.com a@b.com')).toEqual([]);
    expect(extractLinks('javascript:alert(1)')).toEqual([]);
  });

  it('finds links inside non-Latin text', () => {
    expect(extractLinks('رابط https://مثال.موقع/صفحة هنا')).toEqual(['https://مثال.موقع/صفحة']);
  });

  it('deduplicates and returns [] when there is no link', () => {
    expect(extractLinks('https://a.com https://a.com')).toEqual(['https://a.com']);
    expect(extractLinks('just some text')).toEqual([]);
    expect(extractLinks('')).toEqual([]);
  });
});
