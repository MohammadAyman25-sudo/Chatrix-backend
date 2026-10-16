import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { uploadMessageAttachments } from '../middleware/upload.middleware.js';
export const messageRouter = Router();

messageRouter.use(requireAuth);

// Alternative upload endpoint if needed
messageRouter.post('/upload', uploadMessageAttachments, (_req, res) => {
  // This endpoint expects conversation context - better to use conversation-specific endpoint
  res.status(400).json({ message: 'Use POST /conversations/:id/messages with files' });
});
