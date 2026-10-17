import mongoose from 'mongoose';
import type { HydratedDocument, Model, Types } from 'mongoose';
import { normalizeForSearch } from '../utils/searchText.js';

export type MessageStatus = 'sent' | 'delivered' | 'read';
export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'file';

export interface IAttachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
  key?: string;
  name: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface IMessage {
  conversation: Types.ObjectId;
  sender: Types.ObjectId;
  /** Text content - can be empty if only attachments are sent */
  content: string;
  /**
   * Normalized copy of `content` for search (see `utils/searchText.ts`):
   * lowercased, marks stripped, letter variants folded. Maintained by a
   * `pre('save')` hook; never exposed in a DTO.
   */
  contentNormalized: string;
  type: MessageType;
  /** Media/file attachments */
  attachments?: IAttachment[];
  /** The message this message is replying to */
  replyTo?: Types.ObjectId;
  /** Set when the sender edits the content; drives the "edited" label. */
  editedAt?: Date;
  /** True when the message was forwarded from elsewhere; drives the label. */
  forwarded?: boolean;
  /** Everyone who should receive the message (participants minus the sender). */
  recipients: Types.ObjectId[];
  deliveredTo: Types.ObjectId[];
  readTo: Types.ObjectId[];
  /**
   * Per-recipient delivery time (user id -> when). The `deliveredTo` array stays
   * the source of truth for status/unread queries; this map only adds *when* for
   * the "Message info" screen. A timestamp may be missing for messages stored
   * before this field existed.
   */
  deliveredAt: Map<string, Date>;
  /** Per-recipient read time (user id -> when); see `deliveredAt`. */
  readAt: Map<string, Date>;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageModel = Model<IMessage>;
export type MessageDocument = HydratedDocument<IMessage>;

const attachmentSchema = new mongoose.Schema<IAttachment>(
  {
    type: { type: String, enum: ['image', 'video', 'audio', 'file'], required: true },
    url: { type: String, required: true },
    key: { type: String },
    name: { type: String, required: true },
    size: { type: Number, required: true },
    mimeType: { type: String, required: true },
    width: { type: Number },
    height: { type: Number },
    duration: { type: Number },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema<IMessage, MessageModel>(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, trim: true, maxlength: 4000, default: '' },
    contentNormalized: { type: String, default: '', select: false },
    type: { type: String, enum: ['text', 'image', 'video', 'audio', 'file'], default: 'text' },
    attachments: { type: [attachmentSchema], default: [] },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    editedAt: { type: Date },
    forwarded: { type: Boolean, default: false },
    recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    deliveredTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    readTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Timestamps for the "Message info" screen. Kept as Maps rather than arrays
    // of subdocuments: `$set` on a dotted map key (`deliveredAt.<id>`) is
    // idempotent, whereas `$addToSet` on `{ user, at }` subdocuments would add a
    // duplicate whenever the timestamp differs.
    deliveredAt: { type: Map, of: Date, default: {} },
    readAt: { type: Map, of: Date, default: {} },
  },
  { timestamps: true },
);

// Keep the normalized search text in sync on every write (send, forward, edit).
// The query side normalizes with the same function, so case, diacritics and
// letter variants (Arabic أ/ا, German ß, …) never cause a miss.
messageSchema.pre('save', function updateContentNormalized() {
  this.contentNormalized = normalizeForSearch(this.content);
});

// Keyset pagination: newest first, scoped to a conversation.
messageSchema.index({ conversation: 1, _id: -1 });
// Used to find messages still to be marked delivered for a user on connect.
// (Only `recipients` can be indexed; a compound index over two array fields is
// rejected by MongoDB.)
messageSchema.index({ recipients: 1 });

export const Message = mongoose.model<IMessage, MessageModel>('Message', messageSchema);
