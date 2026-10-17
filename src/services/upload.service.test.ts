import { describe, expect, it } from 'vitest';
import { assertUploadConstraints, buildUploadKey, signUploadSchema } from './upload.service.js';

describe('signUploadSchema', () => {
  it('accepts a message upload', () => {
    expect(
      signUploadSchema.parse({
        scope: 'message',
        conversationId: '64f123abc456def789012345',
        name: 'photo.jpg',
        size: 2048,
        mimeType: 'image/jpeg',
      }),
    ).toEqual({
      scope: 'message',
      conversationId: '64f123abc456def789012345',
      name: 'photo.jpg',
      size: 2048,
      mimeType: 'image/jpeg',
    });
  });

  it('accepts an avatar upload with duration omitted', () => {
    expect(
      signUploadSchema.parse({
        scope: 'avatar',
        name: 'avatar.png',
        size: 1024,
        mimeType: 'image/png',
      }),
    ).toEqual({ scope: 'avatar', name: 'avatar.png', size: 1024, mimeType: 'image/png' });
  });

  it('normalizes parameterized MIME types to their canonical base type', () => {
    expect(
      signUploadSchema.parse({
        scope: 'message',
        conversationId: '64f123abc456def789012345',
        name: 'voice-note.webm',
        size: 4096,
        mimeType: 'audio/webm;codecs=opus',
        duration: 7,
      }).mimeType,
    ).toBe('audio/webm');
  });

  it('rejects a zero size', () => {
    expect(
      signUploadSchema.safeParse({ scope: 'avatar', name: 'a.png', size: 0, mimeType: 'image/png' })
        .success,
    ).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(
      signUploadSchema.safeParse({ scope: 'avatar', size: 10, mimeType: 'image/png' }).success,
    ).toBe(false);
  });
});

describe('assertUploadConstraints', () => {
  it('allows image/jpeg for avatars', () => {
    expect(() => assertUploadConstraints('avatar', 'image/jpeg', 1024)).not.toThrow();
  });

  it('rejects image/svg+xml for avatars', () => {
    expect(() => assertUploadConstraints('avatar', 'image/svg+xml', 1024)).toThrow();
  });

  it('rejects an avatar larger than the limit', () => {
    const big = 5 * 1024 * 1024 + 1;
    expect(() => assertUploadConstraints('avatar', 'image/png', big)).toThrow();
  });

  it('allows audio/wav for messages', () => {
    expect(() => assertUploadConstraints('message', 'audio/wav', 1024)).not.toThrow();
  });

  it('allows parameterized types such as browser voice notes', () => {
    expect(() => assertUploadConstraints('message', 'audio/webm;codecs=opus', 1024)).not.toThrow();
    expect(() => assertUploadConstraints('message', 'audio/webm; codecs=opus', 1024)).not.toThrow();
    expect(() => assertUploadConstraints('message', 'Audio/WebM;Codecs=Opus', 1024)).not.toThrow();
    expect(() =>
      assertUploadConstraints('message', 'video/webm;codecs=vp9,opus', 1024),
    ).not.toThrow();
    expect(() =>
      assertUploadConstraints('message', 'text/plain; charset=utf-8', 1024),
    ).not.toThrow();
  });

  it('allows common document, image, video and audio types', () => {
    const samples = [
      'application/octet-stream',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/epub+zip',
      'application/x-7z-compressed',
      'application/vnd.rar',
      'application/gzip',
      'application/x-tar',
      'text/markdown',
      'image/heic',
      'image/avif',
      'video/x-matroska',
      'video/x-ms-wmv',
      'audio/flac',
      'audio/x-m4a',
      'audio/opus',
      'audio/amr',
    ];
    for (const mimeType of samples) {
      expect(() => assertUploadConstraints('message', mimeType, 1024), mimeType).not.toThrow();
    }
  });

  it('accepts parameterized image types for avatars', () => {
    expect(() => assertUploadConstraints('avatar', 'image/png;foo=bar', 1024)).not.toThrow();
  });

  it('rejects an unsupported MIME for messages', () => {
    expect(() => assertUploadConstraints('message', 'font/woff2', 1024)).toThrow();
  });

  it('rejects renderable-markup and executable types for messages', () => {
    expect(() => assertUploadConstraints('message', 'text/html', 1024)).toThrow();
    expect(() => assertUploadConstraints('message', 'application/xhtml+xml', 1024)).toThrow();
    expect(() => assertUploadConstraints('message', 'application/x-msdownload', 1024)).toThrow();
  });

  it('rejects a type with no base MIME type', () => {
    expect(() => assertUploadConstraints('message', ';charset=utf-8', 1024)).toThrow();
  });

  it('rejects a message attachment larger than the limit', () => {
    const big = 100 * 1024 * 1024 + 1;
    expect(() => assertUploadConstraints('message', 'audio/mp4', big)).toThrow();
  });
});

describe('buildUploadKey', () => {
  it('generates an avatar key with the correct extension', () => {
    const key = buildUploadKey('avatar', 'u1', undefined, 'image/webp');
    expect(key).toMatch(/^avatars\/u1\/[0-9a-f-]+\.webp$/i);
  });

  it('generates a group icon key', () => {
    const key = buildUploadKey('group-icon', 'u1', 'g1', 'image/png');
    expect(key).toMatch(/^conversations\/g1\/icon\/[0-9a-f-]+\.png$/i);
  });

  it('generates a message key', () => {
    const key = buildUploadKey('message', 'u1', 'c1', 'video/mp4');
    expect(key).toMatch(/^messages\/c1\/u1\/[0-9a-f-]+\.mp4$/i);
  });

  it('falls back to no extension for unknown MIME', () => {
    const key = buildUploadKey('message', 'u1', 'c1', 'application/unknown');
    expect(key).toMatch(/^messages\/c1\/u1\/[0-9a-f-]+$/i);
  });

  it('resolves the extension for a parameterized MIME', () => {
    const key = buildUploadKey('message', 'u1', 'c1', 'audio/webm;codecs=opus');
    expect(key).toMatch(/^messages\/c1\/u1\/[0-9a-f-]+\.weba$/i);
  });
});
