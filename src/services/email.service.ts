import { Resend } from 'resend';
import { env } from '../config/env.js';
import { JobQueue } from '../utils/queue.js';

export interface VerificationEmail {
  to: string;
  username: string;
  /** Raw token; the service turns it into the verification link. */
  token: string;
}

export interface MessageNotificationEmail {
  to: string;
  /** Recipient's display name (or username). */
  recipientName: string;
  /** Who sent the message. */
  senderName: string;
  /** Group name, or the sender's name for a direct chat. */
  conversationLabel: string;
  /** Short preview of the message body. */
  preview: string;
  /** Deep link into the chat. */
  url: string;
  isGroup: boolean;
}

export interface Mailer {
  sendVerificationEmail(email: VerificationEmail): Promise<void>;
  sendMessageNotification(email: MessageNotificationEmail): Promise<void>;
}

/**
 * Where the verification link points. The frontend owns this route; it passes
 * the token on to `POST /auth/verify-email`.
 */
export function verificationUrl(token: string): string {
  return `${env.CLIENT_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`;
}

/** Where a new-message notification links to. The frontend owns `/chat/:id`. */
export function conversationUrl(conversationId: string): string {
  return `${env.CLIENT_ORIGIN}/chat/${conversationId}`;
}

/** Sends through the Resend API (https://resend.com). */
class ResendMailer implements Mailer {
  private readonly resend: Resend;

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }

  async sendVerificationEmail({ to, username, token }: VerificationEmail): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: env.EMAIL_FROM,
      to: [to],
      subject: 'Verify your Chatrix email',
      text: [
        `Hi ${username},`,
        '',
        'Confirm your email address to activate your Chatrix account:',
        verificationUrl(token),
        '',
        'This link expires in 24 hours and can only be used once.',
        "If you didn't create a Chatrix account you can ignore this email.",
      ].join('\n'),
    });
    if (error) {
      throw new Error(`Resend failed: ${error.name} ${error.message}`);
    }
  }

  async sendMessageNotification(email: MessageNotificationEmail): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: env.EMAIL_FROM,
      to: [email.to],
      subject: email.isGroup
        ? `New message in ${email.conversationLabel}`
        : `New message from ${email.senderName}`,
      text: [
        `Hi ${email.recipientName},`,
        '',
        email.isGroup
          ? `${email.senderName} sent a message in ${email.conversationLabel}:`
          : `${email.senderName} sent you a message:`,
        `"${email.preview}"`,
        '',
        `Open Chatrix to reply: ${email.url}`,
      ].join('\n'),
    });
    if (error) {
      throw new Error(`Resend failed: ${error.name} ${error.message}`);
    }
  }
}

/**
 * Used when `RESEND_API_KEY` is unset: prints the message (link included) to
 * the server console instead of sending it, which is all you need locally.
 */
class ConsoleMailer implements Mailer {
  async sendVerificationEmail({ to, username, token }: VerificationEmail): Promise<void> {
    console.log(
      [
        '[email] ---- verification email (RESEND_API_KEY not set, not sent) ----',
        `[email] To:      ${to}`,
        `[email] From:    ${env.EMAIL_FROM}`,
        '[email] Subject: Verify your Chatrix email',
        `[email] Hi ${username}, confirm your email: ${verificationUrl(token)}`,
        '[email] ----------------------------------------------------------------',
      ].join('\n'),
    );
  }

  async sendMessageNotification(email: MessageNotificationEmail): Promise<void> {
    console.log(
      [
        '[email] ---- new-message notification (RESEND_API_KEY not set, not sent) ----',
        `[email] To:      ${email.to}`,
        `[email] From:    ${env.EMAIL_FROM}`,
        `[email] Subject: ${
          email.isGroup
            ? `New message in ${email.conversationLabel}`
            : `New message from ${email.senderName}`
        }`,
        `[email] Hi ${email.recipientName}, ${email.senderName} wrote: "${email.preview}"`,
        `[email] Open:    ${email.url}`,
        '[email] ---------------------------------------------------------------------',
      ].join('\n'),
    );
  }
}

let warned = false;

function createMailer(): Mailer {
  // Never send real email from tests, even if `.env` holds a live RESEND_API_KEY.
  if (env.NODE_ENV === 'test') {
    return new ConsoleMailer();
  }
  if (env.RESEND_API_KEY) {
    return new ResendMailer(env.RESEND_API_KEY);
  }
  if (env.EMAIL_VERIFICATION_ENABLED && !warned) {
    warned = true;
    console.warn(
      '[email] RESEND_API_KEY is not set; verification emails are logged to the console instead of being sent.',
    );
  }
  return new ConsoleMailer();
}

export const mailer: Mailer = createMailer();

/**
 * All outbound mail goes through this queue so a slow or failing provider never
 * blocks a request. Jobs are retried with exponential backoff; exhausted jobs
 * are logged (the user can always request a new verification link).
 */
export const emailQueue = new JobQueue({
  concurrency: 1,
  maxAttempts: 3,
  baseDelayMs: 1000,
  onError: (job, error) => {
    console.error(`[email] job "${job.label}" failed after all retries:`, error);
  },
});

/** Enqueues a raw job on the shared email queue. Returns the job id. */
export function enqueueEmailJob(label: string, run: () => Promise<void>): string {
  return emailQueue.enqueue(label, run);
}

/** Queues a verification email (never blocks the registration request). */
export function queueVerificationEmail(email: VerificationEmail): string {
  return emailQueue.enqueue(`verification:${email.to}`, () => mailer.sendVerificationEmail(email));
}

/** Queues a new-message notification email. */
export function queueMessageNotification(email: MessageNotificationEmail): string {
  return emailQueue.enqueue(`notification:${email.to}`, () =>
    mailer.sendMessageNotification(email),
  );
}

/** Queued (not yet started) email jobs. */
export function emailQueueSize(): number {
  return emailQueue.size();
}

/**
 * Waits for in-flight/queued email to finish, up to `timeoutMs`, so a shutdown
 * has a chance to flush mail without hanging on a bad provider.
 */
export async function drainEmailQueue(timeoutMs = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([emailQueue.drain(), timeout]);
  if (timer) {
    clearTimeout(timer);
  }
}
