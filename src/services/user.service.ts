import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { User } from '../models/user.model.js';
import type { UserDocument } from '../models/user.model.js';
import { HttpError } from '../middleware/error.middleware.js';
import { storage } from './storage.service.js';
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
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/webm': '.weba',
  'audio/aac': '.aac',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/rtf': '.rtf',
};

export function allowedImageMimeTypes(): string[] {
  return Object.keys(EXTENSION_BY_MIME);
}

export function getFileExtension(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] || '';
}

function avatarKey(userId: string, contentType: string): string {
  const extension = EXTENSION_BY_MIME[contentType];
  if (!extension) {
    throw new HttpError(400, 'Unsupported image type');
  }
  return `avatars/${userId}/${randomUUID()}${extension}`;
}

export async function updateAvatar(
  userId: string,
  file: { buffer: Buffer; contentType: string },
): Promise<PublicUser> {
  const key = avatarKey(userId, file.contentType);
  const user = await User.findById(userId).select('+avatarKey');
  if (!user) {
    throw new HttpError(404, 'User not found');
  }

  const previousKey = user.avatarKey;
  const { url } = await storage.upload({ key, buffer: file.buffer, contentType: file.contentType });

  user.avatarUrl = url;
  user.avatarKey = key;
  await user.save();

  if (previousKey && previousKey !== key) {
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
