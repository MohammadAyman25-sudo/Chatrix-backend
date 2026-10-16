import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { ACCESS_COOKIE, verifyAccessToken } from '../utils/token.js';
import { handleConnection } from './handlers.js';
import { setIO } from './io.js';
import type { AppServer } from './types.js';

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}

export function createSocketServer(httpServer: HttpServer): AppServer {
  const io: AppServer = new Server(httpServer, {
    cors: { origin: env.CLIENT_ORIGIN, credentials: true },
  });

  // Auth reads the same httpOnly access-token cookie as the REST API.
  io.use((socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
    if (!token) {
      next(new Error('Not authenticated'));
      return;
    }
    try {
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    void handleConnection(socket);
  });

  setIO(io);
  return io;
}

export { getIO } from './io.js';
export type { AppServer, ClientToServerEvents, ServerToClientEvents, SocketData } from './types.js';
