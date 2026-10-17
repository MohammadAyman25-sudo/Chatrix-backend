import type { AttachmentDto } from '../types/chat.js';

/**
 * Canonicalizes a MIME type for comparisons and storage: trims it, lowercases
 * it and drops any parameters. Browsers and OSes often report the *full* type,
 * e.g. `audio/webm;codecs=opus` from MediaRecorder (voice notes) or
 * `text/plain; charset=utf-8`; those must match the same allow-list entry as
 * `audio/webm` / `text/plain`.
 */
export function normalizeMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0];
  return (base ?? '').trim().toLowerCase();
}

/**
 * MIME types accepted for message attachments: images, video, audio (including
 * recorded voice notes) and documents. Kept in one place so the upload-signing
 * step and the attachment metadata agree on what is allowed.
 *
 * Matching happens against `normalizeMimeType(...)`, so codec/charset
 * parameters never cause a rejection. `application/octet-stream` is the
 * catch-all many OSes use for documents they cannot label more precisely.
 * Deliberately excluded: renderable-as-markup types (`text/html`,
 * `application/xhtml+xml`, `application/xml`) and executable formats — serving
 * those from the public bucket would be an XSS/malware vector.
 */
export const MESSAGE_MEDIA_MIME_TYPES: readonly string[] = [
  // Images
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/bmp',
  'image/avif',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/x-icon',
  // Videos
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/x-ms-wmv',
  'video/ogg',
  // Audio (browser voice notes arrive as `audio/webm;codecs=opus`)
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
  'audio/m4a',
  'audio/x-m4a',
  'audio/opus',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/amr',
  // Files/Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
  'application/rtf',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/json',
  'text/plain',
  'text/csv',
  'text/markdown',
  // Generic binary: the fallback type for documents no OS/browser can label.
  'application/octet-stream',
];

/** MIME types accepted for a user avatar or a group icon. */
export const AVATAR_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

/** Maps a MIME type to the attachment category the client renders. */
export function determineMediaType(mimeType: string): AttachmentDto['type'] {
  const normalized = normalizeMimeType(mimeType);
  if (normalized.startsWith('image/')) {
    return 'image';
  }
  if (normalized.startsWith('video/')) {
    return 'video';
  }
  if (normalized.startsWith('audio/')) {
    return 'audio';
  }
  return 'file';
}
