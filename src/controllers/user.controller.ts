import type { Request, Response } from 'express';
import { HttpError } from '../middleware/error.middleware.js';
import { routeParam } from '../utils/routeParam.js';
import {
  getSettings,
  getUserProfile,
  removeAvatar,
  searchUsers,
  searchUsersSchema,
  updateProfile,
  updateProfileSchema,
  updateSettings,
  updateSettingsSchema,
} from '../services/user.service.js';

function requireUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }
  return userId;
}

/**
 * Search for people to chat with. Returns a bare array of public profiles
 * (never emails/settings) and always excludes the caller.
 */
export async function searchUsersHandler(req: Request, res: Response): Promise<void> {
  const input = searchUsersSchema.parse(req.query);
  const users = await searchUsers(requireUserId(req), input);
  res.json(users);
}

/** Public profile of a single user; `/users/me` remains the only self endpoint. */
export async function getUserProfileHandler(req: Request, res: Response): Promise<void> {
  const user = await getUserProfile(routeParam(req.params.userId));
  res.json({ user });
}

export async function updateProfileHandler(req: Request, res: Response): Promise<void> {
  const input = updateProfileSchema.parse(req.body);
  const user = await updateProfile(requireUserId(req), input);
  res.json({ user });
}

export async function getSettingsHandler(req: Request, res: Response): Promise<void> {
  const settings = await getSettings(requireUserId(req));
  res.json({ settings });
}

export async function updateSettingsHandler(req: Request, res: Response): Promise<void> {
  const input = updateSettingsSchema.parse(req.body);
  const settings = await updateSettings(requireUserId(req), input);
  res.json({ settings });
}

export async function deleteAvatarHandler(req: Request, res: Response): Promise<void> {
  const user = await removeAvatar(requireUserId(req));
  res.json({ user });
}
