import type { AppServer } from './types.js';

let currentIO: AppServer | undefined;

/** Store the running Socket.IO server so REST handlers and emitters can reach it. */
export function setIO(io: AppServer): void {
  currentIO = io;
}

/** The running Socket.IO server (undefined before startup, e.g. in tests). */
export function getIO(): AppServer | undefined {
  return currentIO;
}
