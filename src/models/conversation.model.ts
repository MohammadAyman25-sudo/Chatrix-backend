import mongoose from 'mongoose';
import type { HydratedDocument, Model, Types } from 'mongoose';

export type ConversationType = 'direct' | 'group';

export interface IConversation {
  type: ConversationType;
  participants: Types.ObjectId[];
  name?: string;
  /** Sorted, colon-joined participant ids; unique per direct conversation. */
  directKey?: string;
  lastMessage?: Types.ObjectId;
  lastMessageAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ConversationModel = Model<IConversation>;
export type ConversationDocument = HydratedDocument<IConversation>;

const conversationSchema = new mongoose.Schema<IConversation, ConversationModel>(
  {
    type: { type: String, enum: ['direct', 'group'], default: 'direct', required: true },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    name: { type: String, trim: true, maxlength: 64 },
    directKey: { type: String, unique: true, sparse: true },
    lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    lastMessageAt: { type: Date },
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });

export const Conversation = mongoose.model<IConversation, ConversationModel>(
  'Conversation',
  conversationSchema,
);
