import mongoose from 'mongoose';
import { HttpError } from '../middleware/error.middleware.js';

/** Opaque, URL-safe cursor wrapping a message (ObjectId) id. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid cursor');
  }
  return id;
}
