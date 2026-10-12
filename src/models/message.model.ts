import mongoose from 'mongoose';
import type { HydratedDocument, Model, Types } from 'mongoose';

export interface IMessage {
  conversation: Types.ObjectId;
  sender: Types.ObjectId;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageModel = Model<IMessage>;
export type MessageDocument = HydratedDocument<IMessage>;

const messageSchema = new mongoose.Schema<IMessage, MessageModel>(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true, trim: true, maxlength: 4000 },
  },
  { timestamps: true },
);

// Keyset pagination: newest first, scoped to a conversation.
messageSchema.index({ conversation: 1, _id: -1 });

export const Message = mongoose.model<IMessage, MessageModel>('Message', messageSchema);
