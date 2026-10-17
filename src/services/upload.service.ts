import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Upload, UPLOAD_SCOPES, type UploadScope } from '../models/upload.model.js';
import { HttpError } from '../middleware/error.middleware.js';
import { storage } from './storage.service.js';
import { getFileExtension, applyAvatar } from './user.service.js';
import { applyGroupAvatar, getConversationForMember } from './conversation.service.js';
import { enqueueJob, registerJobHandler } from './job.service.js';
import {
  AVATAR_MIME_TYPES,
  MESSAGE_MEDIA_MIME_TYPES,
  determineMediaType,
  normalizeMimeType,
} from '../utils/media.js';
import type { AttachmentDto, ConversationDto, PublicUser } from '../types/chat.js';

/** User avatars and group icons. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/** One message attachment (image, video, audio, document, voice note). */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
/** How long a presigned `PUT` URL remains usable. */
export const UPLOAD_SIGN_EXPIRES_SECONDS = 15 * 60;
/** Confirmed bodies are kept; *pending* rows older than this are swept away. */
export const UPLOAD_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** How often the orphan sweep re-runs. */
export const UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const UPLOAD_CLEANUP_DEDUPE_KEY = 'upload:cleanup';

export const signUploadSchema = z.object({
  scope: z.enum([...UPLOAD_SCOPES]),
  /** Required for `message` and `group-icon` uploads; rejected for avatars. */
  conversationId: z.string().optional(),
  /** Original file name, shown in the UI and echoed back as attachment metadata. */
  name: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  // Normalized so codec/charset parameters (`audio/webm;codecs=opus` from
  // MediaRecorder) become the canonical base type before anything stores,
  // signs or keys the upload with it. The client must then PUT with exactly
  // the `Content-Type` returned in `headers`.
  mimeType: z.string().trim().min(1).max(255).transform(normalizeMimeType),
  /** Recording length in seconds (audio/video only). */
  duration: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60)
    .optional(),
});
export type SignUploadInput = z.infer<typeof signUploadSchema>;

export interface SignedUploadDto {
  /** Pass to `POST /uploads/:id/confirm` once the bytes are in the bucket. */
  id: string;
  key: string;
  /** Presigned `PUT` URL: upload the file bytes straight to R2. */
  url: string;
  method: 'PUT';
  /** Headers the PUT must carry (the content type is signed). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export type ConfirmUploadResult =
  | { scope: 'message'; attachment: AttachmentDto }
  | { scope: 'avatar'; user: PublicUser }
  | { scope: 'group-icon'; conversation: ConversationDto };

function humanSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Pure per-scope size/MIME check, shared by the signing endpoint and tests.
 * Avatars accept images only; message attachments accept the full media list.
 */
export function assertUploadConstraints(scope: UploadScope, mimeType: string, size: number): void {
  const allowed = scope === 'message' ? MESSAGE_MEDIA_MIME_TYPES : AVATAR_MIME_TYPES;
  // Compare the canonical base type so parameterized types
  // (`audio/webm;codecs=opus`, `video/webm;codecs=vp9,opus`) match the same
  // entry as `audio/webm` / `video/webm`.
  const normalized = normalizeMimeType(mimeType);
  if (!normalized || !allowed.includes(normalized)) {
    throw new HttpError(
      400,
      scope === 'message'
        ? `Unsupported file type: ${mimeType}`
        : 'Only JPEG, PNG, WebP or GIF images are allowed',
    );
  }

  const limit = scope === 'message' ? ATTACHMENT_MAX_BYTES : AVATAR_MAX_BYTES;
  if (size > limit) {
    throw new HttpError(413, `File is larger than the ${humanSize(limit)} limit`);
  }
}

/** Object key convention, kept stable so stored URLs stay readable. */
export function buildUploadKey(
  scope: UploadScope,
  userId: string,
  conversationId: string | undefined,
  mimeType: string,
): string {
  const extension = getFileExtension(mimeType);
  if (scope === 'avatar') {
    return `avatars/${userId}/${randomUUID()}${extension}`;
  }
  if (scope === 'group-icon') {
    return `conversations/${conversationId}/icon/${randomUUID()}${extension}`;
  }
  return `messages/${conversationId}/${userId}/${randomUUID()}${extension}`;
}

/**
 * Reserves an object key and returns a presigned `PUT` URL. The server never
 * sees the file bytes: the client uploads straight to R2, then confirms.
 * Membership is checked here (non-members get 404, so ids cannot be probed).
 */
export async function signUpload(userId: string, input: SignUploadInput): Promise<SignedUploadDto> {
  assertUploadConstraints(input.scope, input.mimeType, input.size);

  let conversationId: string | undefined;
  if (input.scope === 'avatar') {
    if (input.conversationId) {
      throw new HttpError(400, 'conversationId is not allowed for avatar uploads');
    }
  } else {
    if (!input.conversationId) {
      throw new HttpError(400, 'conversationId is required for this upload');
    }
    conversationId = input.conversationId;
    const conversation = await getConversationForMember(conversationId, userId);
    if (input.scope === 'group-icon' && conversation.type !== 'group') {
      throw new HttpError(400, 'Only group conversations can have an icon');
    }
  }

  const key = buildUploadKey(input.scope, userId, conversationId, input.mimeType);
  const upload = await Upload.create({
    user: userId,
    scope: input.scope,
    conversation: conversationId ?? null,
    key,
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
    duration: input.duration ?? null,
  });

  const presigned = await storage.presignUpload({
    key,
    contentType: input.mimeType,
    expiresInSeconds: UPLOAD_SIGN_EXPIRES_SECONDS,
  });

  return {
    id: String(upload._id),
    key,
    url: presigned.url,
    method: 'PUT',
    headers: presigned.headers,
    expiresAt: presigned.expiresAt,
  };
}

async function toConfirmResult(
  userId: string,
  upload: UploadDocumentLike,
): Promise<ConfirmUploadResult> {
  const url = storage.getPublicUrl(upload.key);
  switch (upload.scope) {
    case 'avatar':
      return { scope: 'avatar', user: await applyAvatar(userId, { key: upload.key, url }) };
    case 'group-icon':
      return {
        scope: 'group-icon',
        conversation: await applyGroupAvatar(userId, String(upload.conversation), {
          key: upload.key,
          url,
        }),
      };
    default: {
      const size = upload.actualSize ?? upload.size;
      return {
        scope: 'message',
        attachment: {
          type: determineMediaType(upload.mimeType),
          url,
          name: upload.name,
          size,
          mimeType: upload.mimeType,
          ...(upload.duration ? { duration: upload.duration } : {}),
        },
      };
    }
  }
}

type UploadDocumentLike = {
  key: string;
  scope: string;
  conversation?: unknown;
  name: string;
  mimeType: string;
  size: number;
  actualSize?: number | null;
  duration?: number | null;
};

/**
 * Verifies the object actually landed in the bucket (size and content type must
 * match what was declared when signing) and returns the metadata to use. The
 * avatar/group-icon variants also swap the stored key, deleting the old object.
 *
 * Repeat calls are idempotent, so a client that times out and retries still gets
 * the attachment/user/conversation back.
 */
export async function confirmUpload(
  userId: string,
  uploadId: string,
): Promise<ConfirmUploadResult> {
  if (!mongoose.isValidObjectId(uploadId)) {
    throw new HttpError(404, 'Upload not found');
  }

  const upload = await Upload.findOne({ _id: uploadId, user: userId });
  if (!upload) {
    throw new HttpError(404, 'Upload not found');
  }

  if (upload.status === 'confirmed') {
    return toConfirmResult(userId, upload);
  }

  const object = await storage.stat(upload.key);
  if (!object) {
    throw new HttpError(400, 'No file found for this upload. Upload it to the signed URL first.');
  }

  if (object.size !== upload.size) {
    await discardUpload(String(upload._id), upload.key);
    throw new HttpError(
      400,
      `Uploaded size (${object.size} bytes) does not match the declared size (${upload.size} bytes)`,
    );
  }
  if (
    object.contentType &&
    normalizeMimeType(object.contentType) !== normalizeMimeType(upload.mimeType)
  ) {
    await discardUpload(String(upload._id), upload.key);
    throw new HttpError(400, 'Uploaded content type does not match the declared type');
  }

  upload.status = 'confirmed';
  upload.actualSize = object.size;
  upload.confirmedAt = new Date();
  await upload.save();

  return toConfirmResult(userId, upload);
}

async function discardUpload(uploadId: string, key: string): Promise<void> {
  await storage.delete(key).catch(() => undefined);
  await Upload.deleteOne({ _id: uploadId });
}

/**
 * Deletes pending uploads that were never confirmed (their signed URL was
 * unused, expired, or the client went away) together with any object that did
 * land in the bucket. Batched so one sweep cannot stall the worker.
 */
export async function cleanupOrphanUploads(now = Date.now(), batchSize = 200): Promise<number> {
  const cutoff = new Date(now - UPLOAD_PENDING_TTL_MS);
  const stale = await Upload.find({ status: 'pending', createdAt: { $lt: cutoff } })
    .select('_id key')
    .limit(batchSize);

  for (const upload of stale) {
    await storage.delete(upload.key).catch(() => undefined);
    await Upload.deleteOne({ _id: upload._id });
  }
  return stale.length;
}

/**
 * Ensures exactly one orphan sweep is queued (the partial unique index on
 * `dedupeKey` makes concurrent scheduling a no-op).
 */
export function scheduleOrphanUploadCleanup(): void {
  void enqueueJob({ type: 'upload:cleanup', dedupeKey: UPLOAD_CLEANUP_DEDUPE_KEY });
}

registerJobHandler('upload:cleanup', async () => {
  const removed = await cleanupOrphanUploads();
  if (removed > 0) {
    console.log(`[uploads] removed ${removed} abandoned upload(s)`);
  }
  // Queue the next sweep. The running job no longer holds the dedupe key, so
  // this insert succeeds and the chain keeps repeating every hour.
  void enqueueJob({
    type: 'upload:cleanup',
    dedupeKey: UPLOAD_CLEANUP_DEDUPE_KEY,
    delayMs: UPLOAD_CLEANUP_INTERVAL_MS,
  });
});
