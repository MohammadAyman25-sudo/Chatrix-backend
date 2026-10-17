import mongoose from 'mongoose';
import type { QueryFilter } from 'mongoose';
import { z } from 'zod';
import { Message } from '../models/message.model.js';
import type { IMessage } from '../models/message.model.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import { LINK_PATTERN_SOURCE, extractLinks } from '../utils/links.js';
import { getConversationForMember } from './conversation.service.js';
import { toMessageDto } from './message.service.js';
import type { ConversationMediaItem } from '../types/chat.js';

/** Attachment types that count as "shared media" (see `determineMediaType`). */
const ATTACHMENT_TYPES = ['image', 'video', 'audio', 'file'] as const;

/**
 * What the media tab can filter by: one attachment kind, `link` for messages
 * containing a URL, or `all` for anything shareable.
 */
export const MEDIA_FILTER_TYPES = ['all', 'image', 'video', 'audio', 'file', 'link'] as const;
export type MediaFilterType = (typeof MEDIA_FILTER_TYPES)[number];

export const listMediaSchema = z.object({
  type: z.enum(MEDIA_FILTER_TYPES).default('all'),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListMediaInput = z.infer<typeof listMediaSchema>;

export interface ConversationMediaResult {
  items: ConversationMediaItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Type clause for the media listing. Attachment kinds match the *attachment*
 * type (not `Message.type`, which is `file` for mixed messages), a message
 * matches if any attachment is of the requested kind, and links are messages
 * whose text contains a URL (same pattern as `extractLinks`).
 */
export function buildMediaTypeFilter(type: MediaFilterType): QueryFilter<IMessage> {
  if (type === 'link') {
    return { content: new RegExp(LINK_PATTERN_SOURCE, 'i') };
  }
  if (type === 'all') {
    return {
      $or: [
        { attachments: { $elemMatch: { type: { $in: [...ATTACHMENT_TYPES] } } } },
        { content: new RegExp(LINK_PATTERN_SOURCE, 'i') },
      ],
    };
  }
  return { attachments: { $elemMatch: { type } } };
}

/**
 * Lists the shareable content of one conversation — photos, videos, voice
 * notes, documents and messages containing links — so a client can render a
 * "media, links and docs" tab instead of scrolling the whole history.
 *
 * Membership is enforced (`getConversationForMember`), newest first, with the
 * same keyset cursor/`limit` semantics as `listMessages` (`limit` counts
 * messages, each carrying its attachments and extracted `links`).
 */
export async function listConversationMedia(
  input: { conversationId: string; userId: string } & ListMediaInput,
): Promise<ConversationMediaResult> {
  const conversation = await getConversationForMember(input.conversationId, input.userId);

  const filter: QueryFilter<IMessage> = {
    conversation: conversation._id,
    ...buildMediaTypeFilter(input.type),
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
  const oldest = page.at(-1);

  return {
    items: page.map((doc) => ({ ...toMessageDto(doc), links: extractLinks(doc.content) })),
    nextCursor: hasMore && oldest ? encodeCursor(oldest.id as string) : null,
    hasMore,
  };
}
