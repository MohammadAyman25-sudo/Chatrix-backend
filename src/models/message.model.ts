import mongoose from 'mongoose';
import type { HydratedDocument, Model, Types } from 'mongoose';

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
    type: { type: String, enum: ['text', 'image', 'video', 'audio', 'file'], default: 'text' },
    attachments: { type: [attachmentSchema], default: [] },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    editedAt: { type: Date },
    forwarded: { type: Boolean, default: false },
    recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    deliveredTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    readTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);

// Keyset pagination: newest first, scoped to a conversation.
messageSchema.index({ conversation: 1, _id: -1 });
// Used to find messages still to be marked delivered for a user on connect.
// (Only `recipients` can be indexed; a compound index over two array fields is
// rejected by MongoDB.)
messageSchema.index({ recipients: 1 });

export const Message = mongoose.model<IMessage, MessageModel>('Message', messageSchema);
