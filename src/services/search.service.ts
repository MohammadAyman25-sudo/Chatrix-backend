import mongoose from 'mongoose';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import { Message } from '../models/message.model.js';
import type { IMessage } from '../models/message.model.js';
import { Conversation } from '../models/conversation.model.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { normalizeForSearch } from '../utils/searchText.js';
import { toConversationDto } from './conversation.service.js';
import { toMessageDto } from './message.service.js';
import { escapeRegex } from './user.service.js';
import type { MessageSearchHit } from '../types/chat.js';

export const searchMessagesSchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});
export type SearchMessagesInput = z.infer<typeof searchMessagesSchema>;

export interface MessageSearchResult {
  items: MessageSearchHit[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Splits a raw query into normalized search tokens. Tokens are matched with
 * AND semantics (every token must appear somewhere in the message), so
 * `hello world` also finds "world, hello!".
 */
export function searchTokens(q: string): string[] {
  return normalizeForSearch(q).split(' ').filter(Boolean);
}

/**
 * Searches the messages of every conversation the caller belongs to.
 *
 * Matching is a substring test against `Message.contentNormalized`: both the
 * stored text and the query ran through `normalizeForSearch`, so it ignores
 * case, diacritics and letter variants across languages (Arabic أ vs ا, German
 * ß vs ss, accents, Arabic-Indic digits, …). Multi-word queries are split into
 * tokens and ANDed. Newest first, with the same keyset cursor as
 * `listMessages`.
 *
 * Scoping is by conversation membership, so messages from chats the caller is
 * not in can never be returned (and the ids are never exposed).
 */
export async function searchMessages(
  input: SearchMessagesInput & { userId: string },
): Promise<MessageSearchResult> {
  const tokens = searchTokens(input.q);
  if (tokens.length === 0) {
    // e.g. a query made only of punctuation/emoji.
    return { items: [], nextCursor: null, hasMore: false };
  }

  const conversations = await Conversation.find({ participants: input.userId })
    .select('_id')
    .lean();
  if (conversations.length === 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const filter: QueryFilter<IMessage> = {
    conversation: { $in: conversations.map((conversation) => conversation._id) },
    // Each token is a literal substring; `searchTokens` already normalized and
    // stripped non-alphanumerics, but escape anyway so the pattern is literal.
    $and: tokens.map((token) => ({ contentNormalized: new RegExp(escapeRegex(token), 'i') })),
  };
  if (input.cursor) {
    filter._id = { $lt: new mongoose.Types.ObjectId(decodeCursor(input.cursor)) };
  }

  const docs = await Message.find(filter)
    .sort({ _id: -1 })
    .limit(input.limit + 1)
    .populate('sender', 'username displayName avatarUrl')
    .populate('replyTo', 'content type attachments sender')
    .populate('replyTo.sender', 'username displayName avatarUrl');

  const hasMore = docs.length > input.limit;
  const page = hasMore ? docs.slice(0, input.limit) : docs;
  if (page.length === 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  // Resolve each hit's conversation so the client can render the chat title
  // without a second lookup (direct conversations have no name, so their
  // participants come along).
  const conversationIds = [...new Set(page.map((doc) => doc.conversation.toString()))];
  const hitConversations = await Conversation.find({ _id: { $in: conversationIds } }).populate(
    'participants',
    'username displayName avatarUrl',
  );
  const byId = new Map(hitConversations.map((doc) => [doc.id as string, toConversationDto(doc)]));

  const oldest = page.at(-1);
  const items = page.flatMap((doc) => {
    const conversation = byId.get(doc.conversation.toString());
    return conversation ? [{ ...toMessageDto(doc), conversation }] : [];
  });

  return {
    items,
    nextCursor: hasMore && oldest ? encodeCursor(oldest.id as string) : null,
    hasMore,
  };
}

/**
 * Fills `contentNormalized` for messages stored before the field existed.
 * Batched so a large history never loads fully into memory, and idempotent:
 * already-normalized documents no longer match the filter. Called once on
 * startup (see `index.ts`).
 */
export async function backfillMessageSearchText(batchSize = 500): Promise<number> {
  let total = 0;

  for (;;) {
    const docs = await Message.find({ contentNormalized: { $exists: false } })
      .select('content')
      .sort({ _id: 1 })
      .limit(batchSize);
    if (docs.length === 0) {
      return total;
    }

    const result = await Message.bulkWrite(
      docs.map((doc) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { contentNormalized: normalizeForSearch(doc.content) } },
        },
      })),
    );
    if (result.modifiedCount === 0) {
      // Nothing changed (e.g. a concurrent writer); stop instead of looping.
      return total;
    }
    total += docs.length;
  }
}
