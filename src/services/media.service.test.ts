import { describe, expect, it } from 'vitest';
import type { QueryFilter } from 'mongoose';
import type { IMessage } from '../models/message.model.js';
import { buildMediaTypeFilter, listMediaSchema } from './media.service.js';

describe('listMediaSchema', () => {
  it('defaults to all types and a limit of 30', () => {
    expect(listMediaSchema.parse({})).toEqual({ type: 'all', limit: 30 });
  });

  it('accepts every filter type and coerces the limit', () => {
    for (const type of ['image', 'video', 'audio', 'file', 'link', 'all'] as const) {
      expect(listMediaSchema.parse({ type, limit: '10' })).toEqual({ type, limit: 10 });
    }
  });

  it('rejects unknown types and out-of-range limits', () => {
    expect(() => listMediaSchema.parse({ type: 'audioo' })).toThrow();
    expect(() => listMediaSchema.parse({ limit: 101 })).toThrow();
    expect(() => listMediaSchema.parse({ limit: 0 })).toThrow();
  });
});

describe('buildMediaTypeFilter', () => {
  it('matches a single attachment kind for media/docs', () => {
    expect(buildMediaTypeFilter('image')).toEqual({
      attachments: { $elemMatch: { type: 'image' } },
    });
    expect(buildMediaTypeFilter('file')).toEqual({
      attachments: { $elemMatch: { type: 'file' } },
    });
  });

  it('matches messages whose content contains a URL for links', () => {
    const filter = buildMediaTypeFilter('link');
    const pattern = filter.content as RegExp;
    expect(pattern).toBeInstanceOf(RegExp);
    expect(pattern.test('see https://example.com')).toBe(true);
    expect(pattern.test('plain text')).toBe(false);
  });

  it('unions attachments and links for all', () => {
    const filter = buildMediaTypeFilter('all');
    expect(filter.$or).toHaveLength(2);
    const [attachments, links] = filter.$or as [QueryFilter<IMessage>, QueryFilter<IMessage>];
    expect(attachments).toEqual({
      attachments: { $elemMatch: { type: { $in: ['image', 'video', 'audio', 'file'] } } },
    });
    expect((links.content as RegExp).test('www.example.org')).toBe(true);
  });
});
