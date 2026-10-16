import mongoose from 'mongoose';
import { User } from '../models/user.model.js';
import { isOnline } from '../sockets/presence.js';
import type { PresenceDto } from '../types/chat.js';

/**
 * Pure projection of a user's presence. Kept separate from the DB lookup so the
 * online/last-seen rules can be unit tested without a database.
 */
export function toPresenceDto(
  userId: string,
  lastSeenAt: Date | null,
  online: boolean,
): PresenceDto {
  return {
    userId,
    status: online ? 'online' : 'offline',
    // While someone is online the last-seen time is not meaningful.
    lastSeenAt: online ? null : (lastSeenAt?.toISOString() ?? null),
  };
}

/**
 * Persist the moment a user was last connected. Called when their final socket
 * disconnects. Invalid ids are ignored so a malformed value can't throw during
 * disconnect handling.
 */
export async function touchLastSeen(userId: string, at: Date): Promise<void> {
  if (!mongoose.isValidObjectId(userId)) {
    return;
  }
  await User.updateOne({ _id: userId }, { $set: { lastSeenAt: at } });
}

/**
 * Live presence for the given users: `online` comes from the in-memory socket
 * registry, `lastSeenAt` from the persisted user record. Order follows `userIds`
 * (deduplicated) and unknown ids are skipped.
 */
export async function getPresenceForUsers(userIds: string[]): Promise<PresenceDto[]> {
  const unique = [...new Set(userIds)].filter((id) => mongoose.isValidObjectId(id));
  if (unique.length === 0) {
    return [];
  }

  const users = await User.find({ _id: { $in: unique } }).select('lastSeenAt');
  const lastSeenById = new Map(users.map((user) => [user.id as string, user.lastSeenAt ?? null]));

  return unique.map((id) => toPresenceDto(id, lastSeenById.get(id) ?? null, isOnline(id)));
}
