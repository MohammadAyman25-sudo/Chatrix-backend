import type { Request, Response } from 'express';
import { HttpError } from '../middleware/error.middleware.js';
import { confirmUpload, signUpload, signUploadSchema } from '../services/upload.service.js';
import { emitConversationUpdated } from '../sockets/emitters.js';
import { routeParam } from '../utils/routeParam.js';

function requireUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, 'Not authenticated');
  }
  return userId;
}

export async function signUploadHandler(req: Request, res: Response): Promise<void> {
  const input = signUploadSchema.parse(req.body);
  const upload = await signUpload(requireUserId(req), input);
  res.status(201).json({
    upload: {
      id: upload.id,
      key: upload.key,
      url: upload.url,
      method: upload.method,
      headers: upload.headers,
      expiresAt: upload.expiresAt,
    },
  });
}

export async function confirmUploadHandler(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req);
  const uploadId = routeParam(req.params.uploadId);
  const result = await confirmUpload(userId, uploadId);

  switch (result.scope) {
    case 'message': {
      res.status(201).json({ attachment: result.attachment });
      return;
    }
    case 'avatar': {
      res.json({ user: result.user });
      return;
    }
    case 'group-icon': {
      emitConversationUpdated(
        result.conversation.participants.map((participant) => participant.id),
        result.conversation,
        userId,
      );
      res.json({ conversation: result.conversation });
      return;
    }
  }
}
