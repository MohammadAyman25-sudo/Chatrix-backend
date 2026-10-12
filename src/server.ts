import http from 'node:http';
import type { Express } from 'express';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { createSocketServer } from './sockets/index.js';

export function createServer(app: Express = createApp()): http.Server {
  const httpServer = http.createServer(app);
  createSocketServer(httpServer);
  return httpServer;
}

export function startServer(httpServer: http.Server): Promise<void> {
  return new Promise((resolve) => {
    httpServer.listen(env.PORT, () => {
      console.log(`API listening on http://localhost:${env.PORT}`);
      resolve();
    });
  });
}
