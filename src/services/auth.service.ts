import { z } from 'zod';
import { User } from '../models/user.model.js';
import type { IUserSettings, UserDocument } from '../models/user.model.js';
import { HttpError } from '../middleware/error.middleware.js';
import { env } from '../config/env.js';
import { generateEmailToken, hashEmailToken } from '../utils/emailToken.js';
import { isPasswordCompromised } from '../utils/pwned.js';
import { validatePasswordPolicy } from '../utils/password.js';
import { queueVerificationEmail } from './email.service.js';
import type { PublicUser, UserSettings } from '../types/chat.js';

/** Verification links are valid for 24 hours. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export const registerSchema = z
  .object({
    username: z.string().min(3).max(32),
    email: z.email(),
    password: z.string(),
    confirmPassword: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: 'custom',
        message: 'Passwords do not match',
        path: ['confirmPassword'],
      });
    }
    for (const message of validatePasswordPolicy(value.password)) {
      ctx.addIssue({ code: 'custom', message, path: ['password'] });
    }
  })
  // `confirmPassword` is only used for validation; never persist it.
  .transform(({ username, email, password }) => ({ username, email, password }));
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1).max(512),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const resendVerificationSchema = z.object({
  email: z.email().toLowerCase(),
});
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

export function toUserSettings(settings: IUserSettings | undefined): UserSettings {
  return {
    theme: settings?.theme ?? 'system',
    notifications: settings?.notifications ?? true,
    readReceipts: settings?.readReceipts ?? true,
  };
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id as string,
    username: user.username,
    displayName: user.displayName ?? null,
    email: user.email,
    emailVerified: Boolean(user.emailVerifiedAt),
    bio: user.bio ?? null,
    avatarUrl: user.avatarUrl ?? null,
    settings: toUserSettings(user.settings),
    createdAt: user.createdAt,
  };
}

/**
 * Delivers a verification email via the email queue, so registration never
 * waits on the mail provider. Failures are retried and logged by the queue; the
 * account already exists and `POST /auth/resend-verification` is how the user
 * retries.
 */
function sendVerificationMail(to: string, username: string, token: string): void {
  queueVerificationEmail({ to, username, token });
}

export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  if (await isPasswordCompromised(input.password)) {
    throw new HttpError(
      400,
      'This password has appeared in a data breach. Please choose a different password.',
    );
  }

  const existing = await User.findOne({
    $or: [{ email: input.email }, { username: input.username }],
  });
  if (existing) {
    throw new HttpError(409, 'Email or username already in use');
  }

  // With verification enabled the account is created unverified: `login` will
  // reject it until the owner clicks the emailed link.
  const verification = env.EMAIL_VERIFICATION_ENABLED ? generateEmailToken() : null;
  const user = await User.create({
    ...input,
    ...(verification && {
      emailVerificationTokenHash: verification.hash,
      emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    }),
  });

  if (verification) {
    sendVerificationMail(user.email, user.username, verification.token);
  }
  return toPublicUser(user);
}

export async function authenticateUser(input: LoginInput): Promise<PublicUser> {
  const user = await User.findOne({ email: input.email }).select('+password');
  if (!user || !(await user.comparePassword(input.password))) {
    throw new HttpError(401, 'Invalid email or password');
  }
  if (env.EMAIL_VERIFICATION_ENABLED && !user.emailVerifiedAt) {
    throw new HttpError(
      403,
      'Email not verified. Check your inbox for the verification link, or request a new one.',
    );
  }
  return toPublicUser(user);
}

/**
 * Redeems a verification token (single use). Looks the user up by the sha256 of
 * the token so the raw token is never stored, and enforces the expiry. Unknown
 * and expired tokens both read as `400` so links can't be probed.
 */
export async function verifyEmail(input: VerifyEmailInput): Promise<PublicUser> {
  // The token fields are `select: false`, so opt in to read (and clear) them.
  const user = await User.findOne({
    emailVerificationTokenHash: hashEmailToken(input.token),
  }).select('+emailVerificationTokenHash +emailVerificationExpiresAt');
  if (!user || !user.emailVerificationExpiresAt) {
    throw new HttpError(400, 'Invalid or expired verification token');
  }
  if (user.emailVerificationExpiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'Invalid or expired verification token');
  }

  user.emailVerifiedAt = new Date();
  // Single use: the token is cleared once redeemed.
  user.emailVerificationTokenHash = undefined;
  user.emailVerificationExpiresAt = undefined;
  await user.save();

  return toPublicUser(user);
}

/**
 * Issues a fresh verification token for an unverified account. Always succeeds
 * from the caller's point of view (`202`), whether or not the address exists or
 * is already verified, so the endpoint can't be used to enumerate accounts.
 * Requesting a new link invalidates the previous one.
 */
export async function resendVerification(input: ResendVerificationInput): Promise<void> {
  const user = await User.findOne({ email: input.email }).select(
    '+emailVerificationTokenHash +emailVerificationExpiresAt',
  );
  if (!user || user.emailVerifiedAt) {
    return;
  }

  const verification = generateEmailToken();
  user.emailVerificationTokenHash = verification.hash;
  user.emailVerificationExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
  await user.save();

  sendVerificationMail(user.email, user.username, verification.token);
}

export async function getUserById(userId: string): Promise<PublicUser> {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'User not found');
  }
  return toPublicUser(user);
}
