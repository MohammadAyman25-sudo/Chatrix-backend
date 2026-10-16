import multer from 'multer';
import { HttpError } from './error.middleware.js';
import { allowedImageMimeTypes } from '../services/user.service.js';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_FILE_BYTES = 100 * 1024 * 1024; // 100MB

// Allowed image types (for avatars)
export function getImageMimeTypes(): string[] {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
}

// Allowed media types for messages (images, videos, audio, files)
export function getMessageMediaMimeTypes(): string[] {
  return [
    // Images
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/bmp',
    // Videos
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    // Audio
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/aac',
    // Files/Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/x-zip-compressed',
    'application/json',
    'text/plain',
    'text/csv',
    'application/rtf',
  ];
}

export function determineMediaType(mimeType: string): 'image' | 'video' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

export const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES },
  fileFilter: (_req, file, callback) => {
    const allowed = allowedImageMimeTypes();
    if (!allowed.includes(file.mimetype)) {
      callback(new HttpError(400, 'Only JPEG, PNG, WebP or GIF images are allowed'));
      return;
    }
    callback(null, true);
  },
}).single('avatar');

export const uploadMessageMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MESSAGE_FILE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!getMessageMediaMimeTypes().includes(file.mimetype)) {
      callback(new HttpError(400, 'Unsupported file type'));
      return;
    }
    callback(null, true);
  },
}).array('files', 10); // Allow up to 10 files per message

export const uploadMessageFiles = uploadMessageMedia;

export const uploadMessageMediaSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MESSAGE_FILE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!getMessageMediaMimeTypes().includes(file.mimetype)) {
      callback(new HttpError(400, 'Unsupported file type'));
      return;
    }
    callback(null, true);
  },
}).single('file');

export const uploadMessageMediaFields = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MESSAGE_FILE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!getMessageMediaMimeTypes().includes(file.mimetype)) {
      callback(new HttpError(400, 'Unsupported file type'));
      return;
    }
    callback(null, true);
  },
}).array('files', 10);

export const uploadSingleFile = uploadMessageMediaSingle;
export const uploadMultipleFiles = uploadMessageMediaFields;

export const uploadMessageAttachments = uploadMessageMedia; // alias
