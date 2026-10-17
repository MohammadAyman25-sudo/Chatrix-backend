import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { io as connectIo } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { createSocketServer } from './index.js';
import { signAccessToken } from '../utils/token.js';
import type { AppServer } from './types.js';

/**
 * Regression tests for the ephemeral status events (`typing:update`,
 * `recording:update`). They run against a real Socket.IO server with the
 * service layer mocked, and deliberately make the connect-time database work
 * slow (or failing): clients emit `typing:start`/`recording:start` the moment
 * they receive `connect`, and Socket.IO silently drops events for which no
 * listener is registered yet. Registering listeners after the awaited bootstrap
 * (the old behaviour) lost exactly these events.
 */
const h = vi.hoisted(() => {
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  return {
    delay,
    /** Overwritten per test so rooms never leak between tests. */
    ids: { a: 'user-a', b: 'user-b', conversation: 'conversation-1' },
    getContactIds: vi.fn(),
    getParticipantIdsForMember: vi.fn(),
    markPendingDelivered: vi.fn(),
    markConversationRead: vi.fn(),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    forwardMessage: vi.fn(),
    touchLastSeen: vi.fn(),
    getUserById: vi.fn(),
  };
});

vi.mock('../services/conversation.service.js', () => ({
  getContactIds: h.getContactIds,
  getParticipantIdsForMember: h.getParticipantIdsForMember,
}));

vi.mock('../services/message.service.js', () => ({
  sendMessageSchema: z.any(),
  editMessageSchema: z.any(),
  forwardMessageSchema: z.any(),
  sendMessage: h.sendMessage,
  editMessage: h.editMessage,
  forwardMessage: h.forwardMessage,
  markConversationRead: h.markConversationRead,
  markPendingDelivered: h.markPendingDelivered,
}));

vi.mock('../services/presence.service.js', () => ({
  touchLastSeen: h.touchLastSeen,
}));

vi.mock('../services/auth.service.js', () => ({
  getUserById: h.getUserById,
}));

let io: AppServer;
let url: string;
let clients: ClientSocket[] = [];
let userSequence = 0;

function connectClient(userId: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = connectIo(url, {
      transports: ['websocket'],
      // Socket.IO auth uses the same httpOnly access-token cookie as the REST API.
      extraHeaders: { cookie: `access_token=${signAccessToken(userId)}` },
      reconnection: false,
    });
    clients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function nextEvent<T>(socket: ClientSocket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    function onEvent(payload: T): void {
      clearTimeout(timer);
      resolve(payload);
    }
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    socket.once(event, onEvent);
  });
}

function collectEvents(socket: ClientSocket, events: string[], count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const received: unknown[] = [];
    const detach = (): void => {
      for (const event of events) {
        socket.off(event, onEvent);
      }
    };
    function onEvent(payload: unknown): void {
      received.push(payload);
      if (received.length === count) {
        detach();
        clearTimeout(timer);
        resolve(received);
      }
    }
    const timer = setTimeout(() => {
      detach();
      reject(new Error(`Timed out after ${received.length}/${count} of [${events.join(', ')}]`));
    }, 2000);
    for (const event of events) {
      socket.on(event, onEvent);
    }
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  userSequence += 1;
  h.ids = {
    a: `user-a-${userSequence}`,
    b: `user-b-${userSequence}`,
    conversation: `conversation-${userSequence}`,
  };

  // Simulated DB latency on the connect path: this is what pushed the old code
  // past the point where clients emit their first typing/recording events.
  h.getContactIds.mockImplementation(async () => {
    await h.delay(100);
    return [];
  });
  h.getParticipantIdsForMember.mockImplementation(async () => [h.ids.a, h.ids.b]);
  h.markPendingDelivered.mockResolvedValue([]);
  h.markConversationRead.mockResolvedValue([h.ids.a, h.ids.b]);
  h.touchLastSeen.mockResolvedValue(undefined);
  h.getUserById.mockResolvedValue({ id: h.ids.a, settings: { readReceipts: true } });

  io = createSocketServer(http.createServer());
  await new Promise<void>((resolve) => {
    io.httpServer?.listen(0, () => {
      const address = io.httpServer?.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      url = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  for (const client of clients) {
    client.disconnect();
  }
  clients = [];
  await new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
});

describe('socket presence status relays', () => {
  it('relays typing:start emitted immediately after connect', async () => {
    const b = await connectClient(h.ids.b);
    await h.delay(25); // let B finish joining its `user:` room

    const a = await connectClient(h.ids.a);
    a.emit('typing:start', { conversationId: h.ids.conversation });

    const payload = await nextEvent<{ conversationId: string; userId: string; isTyping: boolean }>(
      b,
      'typing:update',
    );
    expect(payload).toEqual({ conversationId: h.ids.conversation, userId: h.ids.a, isTyping: true });
  });

  it('relays typing:stop and the recording start/stop pair, never back to the sender', async () => {
    const b = await connectClient(h.ids.b);
    await h.delay(25);

    const a = await connectClient(h.ids.a);
    const received = collectEvents(b, ['typing:update', 'recording:update'], 3);
    const heardBySender: unknown[] = [];
    a.on('typing:update', (payload: unknown) => heardBySender.push(payload));
    a.on('recording:update', (payload: unknown) => heardBySender.push(payload));

    a.emit('typing:stop', { conversationId: h.ids.conversation });
    a.emit('recording:start', { conversationId: h.ids.conversation });
    a.emit('recording:stop', { conversationId: h.ids.conversation });

    expect(await received).toEqual([
      { conversationId: h.ids.conversation, userId: h.ids.a, isTyping: false },
      { conversationId: h.ids.conversation, userId: h.ids.a, isRecording: true },
      { conversationId: h.ids.conversation, userId: h.ids.a, isRecording: false },
    ]);
    expect(heardBySender).toEqual([]);
  });

  it('relays status events even when the connect-time DB bootstrap fails', async () => {
    const b = await connectClient(h.ids.b);
    await h.delay(25);

    // The bootstrap (presence + pending deliveries) blows up right before A's
    // socket finishes connecting; status relays must survive that.
    h.getContactIds.mockRejectedValueOnce(new Error('database unavailable'));

    const a = await connectClient(h.ids.a);
    a.emit('typing:start', { conversationId: h.ids.conversation });
    a.emit('recording:start', { conversationId: h.ids.conversation });

    const received = await collectEvents(b, ['typing:update', 'recording:update'], 2);
    expect(received).toEqual([
      { conversationId: h.ids.conversation, userId: h.ids.a, isTyping: true },
      { conversationId: h.ids.conversation, userId: h.ids.a, isRecording: true },
    ]);
  });

  it('still acks message:send emitted immediately after connect', async () => {
    await connectClient(h.ids.b);
    await h.delay(25);

    h.sendMessage.mockResolvedValue({
      message: { id: 'message-1', content: 'hi' },
      participantIds: [h.ids.a, h.ids.b],
    });

    const a = await connectClient(h.ids.a);
    const acked = new Promise<{ ok: boolean }>((resolve, reject) => {
      a.timeout(2000).emit(
        'message:send',
        { conversationId: h.ids.conversation, content: 'hi' },
        (error: Error | null, response: { ok: boolean }) => {
          if (error) {
            reject(error);
          } else {
            resolve(response);
          }
        },
      );
    });

    await expect(acked).resolves.toMatchObject({ ok: true });
  });
});
