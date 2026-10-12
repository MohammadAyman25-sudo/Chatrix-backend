import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { ACCESS_COOKIE, verifyAccessToken } from '../utils/token.js';

export interface SocketData {
  userId: string;
}

let currentIO: Server | undefined;

/** Access the running Socket.IO server from REST controllers (undefined in tests). */
export function getIO(): Server | undefined {
  return currentIO;
}

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

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
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
    const userId = (socket.data as SocketData).userId;
    socket.join(`user:${userId}`);
    console.log(`socket connected: ${socket.id} (user ${userId})`);

    socket.on('disconnect', (reason) => {
      console.log(`socket disconnected: ${socket.id} (${reason})`);
    });
  });

  currentIO = io;
  return io;
}
