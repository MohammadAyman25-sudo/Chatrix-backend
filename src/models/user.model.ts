import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import type { HydratedDocument, Model } from 'mongoose';

export type ThemePreference = 'light' | 'dark' | 'system';

export interface IUserSettings {
  theme: ThemePreference;
  notifications: boolean;
  readReceipts: boolean;
}

export interface IUser {
  username: string;
  email: string;
  password: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  /** Object-storage key of the current avatar, used to delete the previous file. */
  avatarKey?: string;
  /** When the owner clicked the verification link; null until verified. */
  emailVerifiedAt?: Date;
  /** sha256 of the outstanding verification token (never the raw token). */
  emailVerificationTokenHash?: string;
  /** Expiry of the outstanding verification token. */
  emailVerificationExpiresAt?: Date;
  /** Last time the user was connected; refreshed when their last socket disconnects. */
  lastSeenAt?: Date;
  settings: IUserSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserMethods {
  comparePassword(candidate: string): Promise<boolean>;
}

type UserModel = Model<IUser, Record<string, never>, IUserMethods>;

const userSettingsSchema = new mongoose.Schema<IUserSettings>(
  {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    notifications: { type: Boolean, default: true },
    readReceipts: { type: Boolean, default: true },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema<IUser, UserModel, IUserMethods>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 32,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    displayName: {
      type: String,
      trim: true,
      maxlength: 50,
    },
    bio: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    avatarUrl: {
      type: String,
    },
    avatarKey: {
      type: String,
      select: false,
    },
    emailVerifiedAt: {
      type: Date,
    },
    emailVerificationTokenHash: {
      type: String,
      select: false,
    },
    emailVerificationExpiresAt: {
      type: Date,
      select: false,
    },
    lastSeenAt: {
      type: Date,
    },
    settings: {
      type: userSettingsSchema,
      default: () => ({}),
    },
  },
  { timestamps: true },
);

userSchema.pre('save', async function () {
  if (!this.isModified('password')) {
    return;
  }
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model<IUser, UserModel>('User', userSchema);

export type UserDocument = HydratedDocument<IUser, IUserMethods>;
