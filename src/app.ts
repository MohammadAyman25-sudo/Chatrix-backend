import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { globalLimiter } from './middleware/rateLimit.middleware.js';
import { apiRouter } from './routes/index.js';
import { LOCAL_UPLOAD_DIR } from './services/storage.service.js';

export const API_PREFIX = '/api/v1';

export function createApp(): Express {
  const app = express();

  // Required so rate limiting keys on the real client IP when deployed behind a
  // reverse proxy (nginx/Vercel/etc). Leave TRUST_PROXY=0 when exposed directly.
  if (env.TRUST_PROXY > 0) {
    app.set('trust proxy', env.TRUST_PROXY);
  }

  // credentials: true requires an explicit origin, not '*'.
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  if (env.MEDIA_DISK === 'local') {
    app.use('/uploads', express.static(LOCAL_UPLOAD_DIR));
  }

  // Broad IP-based safety net for the whole API surface.
  app.use(API_PREFIX, globalLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
