import { Router } from 'express';
import { authRouter } from './auth.routes.js';
import { conversationRouter } from './conversation.routes.js';
import { userRouter } from './user.routes.js';
import { messageRouter } from './message.routes.js';
import { uploadRouter } from './upload.routes.js';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/conversations', conversationRouter);
apiRouter.use('/messages', messageRouter);
apiRouter.use('/uploads', uploadRouter);
