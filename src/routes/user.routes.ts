import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { uploadAvatar } from '../middleware/upload.middleware.js';
import { searchLimiter, uploadLimiter } from '../middleware/rateLimit.middleware.js';
import {
  deleteAvatarHandler,
  getSettingsHandler,
  getUserProfileHandler,
  searchUsersHandler,
  updateProfileHandler,
  updateSettingsHandler,
  uploadAvatarHandler,
} from '../controllers/user.controller.js';

export const userRouter = Router();

userRouter.use(requireAuth);

userRouter.patch('/me', updateProfileHandler);
userRouter.get('/me/settings', getSettingsHandler);
userRouter.patch('/me/settings', updateSettingsHandler);
userRouter.post('/me/avatar', uploadLimiter, uploadAvatar, uploadAvatarHandler);
userRouter.delete('/me/avatar', deleteAvatarHandler);

// `/search` must be declared before `/:userId` so it is not captured as an id.
userRouter.get('/search', searchLimiter, searchUsersHandler);
userRouter.get('/:userId', getUserProfileHandler);
