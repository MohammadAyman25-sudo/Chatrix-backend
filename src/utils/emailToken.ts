import { createHash, randomBytes } from 'node:crypto';

/** Verification tokens carry 256 bits of entropy; only their sha256 is stored. */
export const EMAIL_TOKEN_BYTES = 32;

export interface EmailToken {
  /** Raw token, embedded in the link sent to the user's inbox. */
  token: string;
  /** sha256 hex digest of `token`, the only part persisted on the user. */
  hash: string;
}

export function hashEmailToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateEmailToken(): EmailToken {
  const token = randomBytes(EMAIL_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashEmailToken(token) };
}
