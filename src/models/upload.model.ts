import { Schema, model } from 'mongoose';

export const UPLOAD_SCOPES = ['message', 'avatar', 'group-icon'] as const;
export type UploadScope = (typeof UPLOAD_SCOPES)[number];

export const UPLOAD_STATUSES = ['pending', 'confirmed'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/**
 * One direct-to-R2 upload: created when the client asks for a presigned URL
 * (`pending`) and flipped to `confirmed` once the object is verified to exist.
 * Pending rows whose `key` never landed in the bucket are swept by the
 * `upload:cleanup` background job, so abandoned uploads do not accumulate.
 */
const uploadSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scope: { type: String, required: true, enum: [...UPLOAD_SCOPES] },
    /** Set for message attachments and group icons; null for user avatars. */
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
    /** Object key in the R2 bucket (unique; also the identity of the object). */
    key: { type: String, required: true, unique: true },
    /** Original file name, echoed back as attachment metadata. */
    name: { type: String, required: true },
    mimeType: { type: String, required: true },
    /** Size the client declared when signing; re-checked against the object. */
    size: { type: Number, required: true },
    /** Size reported by the bucket on confirm. */
    actualSize: { type: Number, default: null },
    /** Duration in seconds for audio/video attachments (optional). */
    duration: { type: Number, default: null },
    status: { type: String, required: true, enum: [...UPLOAD_STATUSES], default: 'pending' },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Orphan sweeping scans pending rows oldest-first.
uploadSchema.index({ status: 1, createdAt: 1 });

export const Upload = model('Upload', uploadSchema);
