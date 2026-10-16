const userSockets = new Map<string, Set<string>>();

/** Track a connected socket. Returns true when the user just came online. */
export function registerSocket(userId: string, socketId: string): boolean {
  const sockets = userSockets.get(userId) ?? new Set<string>();
  sockets.add(socketId);
  userSockets.set(userId, sockets);
  return sockets.size === 1;
}

/** Remove a connected socket. Returns true when the user has no sockets left. */
export function unregisterSocket(userId: string, socketId: string): boolean {
  const sockets = userSockets.get(userId);
  if (!sockets) {
    return false;
  }
  sockets.delete(socketId);
  if (sockets.size === 0) {
    userSockets.delete(userId);
    return true;
  }
  return false;
}

export function isOnline(userId: string): boolean {
  return (userSockets.get(userId)?.size ?? 0) > 0;
}

export function onlineUserIds(): string[] {
  return [...userSockets.keys()];
}
