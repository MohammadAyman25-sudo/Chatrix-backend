import { getContactIds, getParticipantIdsForMember } from '../services/conversation.service.js';
import {
  editMessage,
  editMessageSchema,
  forwardMessage,
  forwardMessageSchema,
  markConversationRead,
  markPendingDelivered,
  sendMessage,
  sendMessageSchema,
} from '../services/message.service.js';
import { touchLastSeen } from '../services/presence.service.js';
import { getUserById } from '../services/auth.service.js';
import { HttpError } from '../middleware/error.middleware.js';
import { consume } from '../utils/rateLimiter.js';
import {
  emitConversationNew,
  emitForwardedMessages,
  emitMessageEdited,
  emitMessageStatus,
  emitNewMessage,
  emitPresence,
  emitRecording,
  emitTyping,
} from './emitters.js';
import { registerSocket, unregisterSocket } from './presence.js';
import type {
  AppSocket,
  ConversationPayload,
  EditMessageAck,
  EditMessagePayload,
  ForwardMessageAck,
  ForwardMessagePayload,
  SendMessagePayload,
  SendMessageAck,
} from './types.js';

const MESSAGE_RATE_LIMIT = 60;
const MESSAGE_RATE_WINDOW_MS = 60 * 1000;
const EDIT_RATE_LIMIT = 30;
const EDIT_RATE_WINDOW_MS = 60 * 1000;
const FORWARD_RATE_LIMIT = 30;
const FORWARD_RATE_WINDOW_MS = 60 * 1000;

async function relayTyping(socket: AppSocket, payload: ConversationPayload, isTyping: boolean) {
  const userId = socket.data.userId;
  const participants = await getParticipantIdsForMember(payload?.conversationId ?? '', userId);
  if (!participants) {
    return;
  }
  emitTyping(participants, { conversationId: payload.conversationId, userId, isTyping }, userId);
}

async function relayRecording(
  socket: AppSocket,
  payload: ConversationPayload,
  isRecording: boolean,
) {
  const userId = socket.data.userId;
  const participants = await getParticipantIdsForMember(payload?.conversationId ?? '', userId);
  if (!participants) {
    return;
  }
  emitRecording(
    participants,
    { conversationId: payload.conversationId, userId, isRecording },
    userId,
  );
}

async function handleSendMessage(
  socket: AppSocket,
  payload: SendMessagePayload,
  ack: SendMessageAck | undefined,
): Promise<void> {
  const userId = socket.data.userId;

  // Socket.IO is the primary send path, so throttle it here too (not just REST).
  if (!consume(`message:send:${userId}`, MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS)) {
    if (typeof ack === 'function') {
      ack({ ok: false, error: 'You are sending messages too quickly.' });
    }
    return;
  }

  try {
    const parsed = sendMessageSchema.parse(payload);
    const { message, participantIds, createdConversation } = await sendMessage({
      ...parsed,
      senderId: userId,
    });

    // A private reply may have created a direct conversation: announce it before
    // the message so recipients can resolve the conversation.
    if (createdConversation) {
      emitConversationNew(
        createdConversation.participants.map((participant) => participant.id),
        createdConversation,
        userId,
      );
    }

    // Sender gets the canonical message back via the ack; others via `message:new`.
    emitNewMessage(participantIds, message, userId);

    if (typeof ack === 'function') {
      ack({
        ok: true,
        message,
        clientTempId: parsed.clientTempId,
        ...(createdConversation && { conversation: createdConversation }),
      });
    }
  } catch (error) {
    if (typeof ack === 'function') {
      ack({
        ok: false,
        error: error instanceof HttpError ? error.message : 'Failed to send message',
      });
    }
  }
}

async function handleEditMessage(
  socket: AppSocket,
  payload: EditMessagePayload,
  ack: EditMessageAck | undefined,
): Promise<void> {
  const userId = socket.data.userId;

  if (!consume(`message:edit:${userId}`, EDIT_RATE_LIMIT, EDIT_RATE_WINDOW_MS)) {
    if (typeof ack === 'function') {
      ack({ ok: false, error: 'You are editing messages too quickly.' });
    }
    return;
  }

  try {
    const { content } = editMessageSchema.parse(payload);
    const { message, participantIds } = await editMessage({
      conversationId: payload?.conversationId ?? '',
      messageId: payload?.messageId ?? '',
      content,
      userId,
    });

    // Editor gets the canonical message back via the ack; others via `message:edited`.
    emitMessageEdited(participantIds, message, userId);

    if (typeof ack === 'function') {
      ack({ ok: true, message });
    }
  } catch (error) {
    if (typeof ack === 'function') {
      ack({
        ok: false,
        error: error instanceof HttpError ? error.message : 'Failed to edit message',
      });
    }
  }
}

async function handleForwardMessage(
  socket: AppSocket,
  payload: ForwardMessagePayload,
  ack: ForwardMessageAck | undefined,
): Promise<void> {
  const userId = socket.data.userId;

  if (!consume(`message:forward:${userId}`, FORWARD_RATE_LIMIT, FORWARD_RATE_WINDOW_MS)) {
    if (typeof ack === 'function') {
      ack({ ok: false, error: 'You are forwarding messages too quickly.' });
    }
    return;
  }

  try {
    const parsed = forwardMessageSchema.parse({
      conversationIds: payload?.conversationIds ?? [],
      userIds: payload?.userIds ?? [],
    });
    const { messages, deliveries, createdConversations } = await forwardMessage({
      ...parsed,
      conversationId: payload?.conversationId ?? '',
      messageId: payload?.messageId ?? '',
      userId,
    });

    // Sender gets the copies back via the ack; targets via `message:new`
    // (and `conversation:new` for any freshly created direct conversation).
    emitForwardedMessages(deliveries, createdConversations, userId);

    if (typeof ack === 'function') {
      ack({
        ok: true,
        messages,
        ...(createdConversations.length > 0 && { conversations: createdConversations }),
      });
    }
  } catch (error) {
    if (typeof ack === 'function') {
      ack({
        ok: false,
        error: error instanceof HttpError ? error.message : 'Failed to forward message',
      });
    }
  }
}

async function handleRead(socket: AppSocket, payload: ConversationPayload): Promise<void> {
  const userId = socket.data.userId;
  const conversationId = payload?.conversationId ?? '';

  const participants = await markConversationRead(conversationId, userId);
  if (!participants) {
    return;
  }

  // Read receipts are private: respect the reader's setting.
  const reader = await getUserById(userId);
  if (!reader.settings.readReceipts) {
    return;
  }

  emitMessageStatus(
    participants,
    { conversationId, userId, status: 'read', at: new Date().toISOString() },
    userId,
  );
}

async function handlePendingDeliveries(socket: AppSocket): Promise<void> {
  const userId = socket.data.userId;
  const pending = await markPendingDelivered(userId);
  const at = new Date().toISOString();

  for (const { conversationId, senderId } of pending) {
    emitMessageStatus([senderId], { conversationId, userId, status: 'delivered', at });
  }
}

export async function handleConnection(socket: AppSocket): Promise<void> {
  const userId = socket.data.userId;
  socket.join(`user:${userId}`);

  const cameOnline = registerSocket(userId, socket.id);

  // Register every listener *before* any awaited work. Clients emit events
  // (`typing:start`, `recording:start`, sends, …) as soon as they receive
  // `connect`, and Socket.IO silently drops events that have no listener yet.
  // The presence/pending-delivery bootstrap below does several DB round-trips;
  // it used to run first, which made freshly connected clients lose their first
  // typing/recording events — and a failure there skipped registration entirely.
  socket.on('message:send', (payload, ack) => {
    void handleSendMessage(socket, payload, ack);
  });

  socket.on('message:edit', (payload, ack) => {
    void handleEditMessage(socket, payload, ack);
  });

  socket.on('message:forward', (payload, ack) => {
    void handleForwardMessage(socket, payload, ack);
  });

  socket.on('typing:start', (payload) => {
    void relayTyping(socket, payload, true).catch(() => undefined);
  });

  socket.on('typing:stop', (payload) => {
    void relayTyping(socket, payload, false).catch(() => undefined);
  });

  socket.on('recording:start', (payload) => {
    void relayRecording(socket, payload, true).catch(() => undefined);
  });

  socket.on('recording:stop', (payload) => {
    void relayRecording(socket, payload, false).catch(() => undefined);
  });

  socket.on('message:read', (payload) => {
    void handleRead(socket, payload).catch(() => undefined);
  });

  socket.on('disconnect', () => {
    void (async () => {
      const wentOffline = unregisterSocket(userId, socket.id);
      if (!wentOffline) {
        return;
      }
      const at = new Date();
      // Persist "last seen" so it survives restarts and can be fetched later.
      await touchLastSeen(userId, at).catch(() => undefined);
      const contacts = await getContactIds(userId).catch(() => []);
      emitPresence(contacts, { userId, status: 'offline', lastSeenAt: at.toISOString() });
    })();
  });

  // Presence/pending-delivery bootstrap. Listeners are already attached, so a
  // slow or failing database here can no longer break this socket's events.
  if (!cameOnline) {
    return;
  }
  try {
    const contacts = await getContactIds(userId);
    emitPresence(contacts, { userId, status: 'online', lastSeenAt: null });
    await handlePendingDeliveries(socket);
  } catch (error) {
    console.error(`[sockets] failed to announce presence for ${userId}:`, error);
  }
}
