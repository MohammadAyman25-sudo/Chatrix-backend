import { describe, expect, it } from 'vitest';
import { determineMediaType, normalizeMimeType } from './media.js';

describe('normalizeMimeType', () => {
  it('strips codec parameters reported by MediaRecorder', () => {
    expect(normalizeMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
  });

  it('strips parameters around spaces and lowercases', () => {
    expect(normalizeMimeType(' Audio/WebM ; codecs=Opus ')).toBe('audio/webm');
  });

  it('strips charset parameters', () => {
    expect(normalizeMimeType('text/plain; charset=utf-8')).toBe('text/plain');
  });

  it('leaves plain types untouched', () => {
    expect(normalizeMimeType('application/pdf')).toBe('application/pdf');
  });

  it('normalizes parameter-only input to an empty string', () => {
    expect(normalizeMimeType(';charset=utf-8')).toBe('');
  });
});

describe('determineMediaType', () => {
  it('categorizes parameterized types', () => {
    expect(determineMediaType('audio/webm;codecs=opus')).toBe('audio');
    expect(determineMediaType('video/webm;codecs=vp9,opus')).toBe('video');
    expect(determineMediaType('IMAGE/JPEG;quality=baseline')).toBe('image');
  });

  it('categorizes plain types', () => {
    expect(determineMediaType('image/png')).toBe('image');
    expect(determineMediaType('audio/mpeg')).toBe('audio');
    expect(determineMediaType('application/pdf')).toBe('file');
    expect(determineMediaType('application/octet-stream')).toBe('file');
  });
});
