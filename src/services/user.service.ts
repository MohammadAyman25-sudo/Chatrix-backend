import mongoose from 'mongoose';
import { z } from 'zod';
import { User } from '../models/user.model.js';
import type { UserDocument } from '../models/user.model.js';
import { HttpError } from '../middleware/error.middleware.js';
import { storage } from './storage.service.js';
import { normalizeMimeType } from '../utils/media.js';
import { toPublicUser, toUserSettings } from './auth.service.js';
import type { PublicProfile, PublicUser, UserSettings } from '../types/chat.js';

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(50).nullable().optional(),
    bio: z.string().trim().max(200).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updateSettingsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    notifications: z.boolean().optional(),
    readReceipts: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No settings to update' });
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const searchUsersSchema = z.object({
  q: z.string().trim().min(1).max(50),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchUsersInput = z.infer<typeof searchUsersSchema>;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/x-icon': '.ico',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'video/x-ms-wmv': '.wmv',
  'video/ogg': '.ogv',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/webm': '.weba',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/opus': '.opus',
  'audio/x-wav': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/amr': '.amr',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'application/epub+zip': '.epub',
  'application/rtf': '.rtf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-tar': '.tar',
  'application/x-7z-compressed': '.7z',
  'application/vnd.rar': '.rar',
  'application/x-rar-compressed': '.rar',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
};

/**
 * Extension for an object key. The lookup is normalized, so a declared type
 * with parameters (`audio/webm;codecs=opus`) still resolves; unknown types
 * (including `application/octet-stream`) fall back to no extension.
 */
export function getFileExtension(mimeType: string): string {
  return EXTENSION_BY_MIME[normalizeMimeType(mimeType)] ?? '';
}

/**
 * Points the user's avatar at an object that was uploaded directly to the
 * bucket through the presigned-upload flow, deleting the previous icon.
 */
export async function applyAvatar(
  userId: string,
  file: { key: string; url: string },
): Promise<PublicUser> {
  const user = await User.findById(userId).select('+avatarKey');
  if (!user) {
    throw new HttpError(404, 'User not found');
  }

  const previousKey = user.avatarKey;
  user.avatarUrl = file.url;
  user.avatarKey = file.key;
  await user.save();

  if (previousKey && previousKey !== file.key) {
    await storage.delete(previousKey).catch(() => undefined);
  }
  return toPublicUser(user);
}

export async function removeAvatar(userId: string): Promise<PublicUser> {
  const user = await User.findById(userId).select('+avatarKey');
  if (!user) {
    throw new HttpError(404, 'User not found');
  }

  const previousKey = user.avatarKey;
  user.avatarUrl = undefined;
  user.avatarKey = undefined;
  await user.save();

  if (previousKey) {
    await storage.delete(previousKey).catch(() => undefined);
  }
  return toPublicUser(user);
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<PublicUser> {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'User not found');
  }

  if (input.displayName !== undefined) {
    user.displayName = input.displayName ?? undefined;
  }
  if (input.bio !== undefined) {
    user.bio = input.bio ?? undefined;
  }

  await user.save();
  return toPublicUser(user);
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const user = await User.findById(userId).select('settings');
  if (!user) {
    throw new HttpError(404, 'User not found');
  }
  return toUserSettings(user.settings);
}

export async function updateSettings(
  userId: string,
  input: UpdateSettingsInput,
): Promise<UserSettings> {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'User not found');
  }

  if (input.theme !== undefined) {
    user.settings.theme = input.theme;
  }
  if (input.notifications !== undefined) {
    user.settings.notifications = input.notifications;
  }
  if (input.readReceipts !== undefined) {
    user.settings.readReceipts = input.readReceipts;
  }

  await user.save();
  return toUserSettings(user.settings);
}

/** Escapes user input before it is embedded into a `RegExp` (ReDoS safety). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Projects a user document down to the fields that are safe to expose about
 * someone else. Never include `email`, `settings`, `password` or `avatarKey`.
 */
export function toPublicProfile(user: UserDocument): PublicProfile {
  return {
    id: user.id as string,
    username: user.username,
    displayName: user.displayName ?? null,
    bio: user.bio ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

/**
 * Case-insensitive search over `username` and `displayName`, excluding the
 * caller. Returns public profiles only (see `toPublicProfile`).
 */
export async function searchUsers(
  currentUserId: string,
  input: SearchUsersInput,
): Promise<PublicProfile[]> {
  const pattern = new RegExp(escapeRegex(input.q), 'i');
  const users = await User.find({
    _id: { $ne: currentUserId },
    $or: [{ username: pattern }, { displayName: pattern }],
  })
    .select('username displayName bio avatarUrl')
    .sort({ username: 1 })
    .limit(input.limit);

  return users.map(toPublicProfile);
}

/**
 * Public profile of another user. Invalid or missing ids both return 404 so the
 * response cannot be used to probe which ids exist.
 */
export async function getUserProfile(targetId: string): Promise<PublicProfile> {
  if (!mongoose.isValidObjectId(targetId)) {
    throw new HttpError(404, 'User not found');
  }
  const user = await User.findById(targetId).select('username displayName bio avatarUrl');
  if (!user) {
    throw new HttpError(404, 'User not found');
  }
  return toPublicProfile(user);
}
