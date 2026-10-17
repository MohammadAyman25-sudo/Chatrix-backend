import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { attachmentLimiter, uploadLimiter } from '../middleware/rateLimit.middleware.js';
import { confirmUploadHandler, signUploadHandler } from '../controllers/upload.controller.js';

export const uploadRouter = Router();

uploadRouter.use(requireAuth);

/**
 * Returns a presigned `PUT` URL that the client uploads file bytes to directly.
 * `POST /api/v1/uploads/sign` { scope: 'message'|'avatar'|'group-icon', ... }
 */
uploadRouter.post('/sign', uploadLimiter, signUploadHandler);

/**
 * Confirms the object landed in the bucket. Applies it to the user/conversation
 * (or returns the attachment metadata for message attachments).
 */
uploadRouter.post('/:uploadId/confirm', attachmentLimiter, confirmUploadHandler);
