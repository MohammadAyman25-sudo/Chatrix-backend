import { createHash } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Compromised-password detection.
 *
 * Two layers:
 *  1. A bundled list of very common passwords (always checked, works offline).
 *  2. Have I Been Pwned's Pwned Passwords range API using k-anonymity: only the
 *     first 5 hex characters of the SHA-1 hash ever leave the process, so the
 *     real password is never sent. Network failures fail open (the password is
 *     allowed) so registration never breaks because a third party is down.
 */

const PWNED_RANGE_URL = 'https://api.pwnedpasswords.com/range';
const PWNED_TIMEOUT_MS = 3000;

// Lowercase; compared against `password.toLowerCase()`.
const COMMON_PASSWORDS = new Set([
  '123456',
  '12345678',
  '123456789',
  '1234567890',
  '12345',
  'password',
  'password1',
  'password123',
  'qwerty',
  'qwerty123',
  '111111',
  '000000',
  'abc123',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'admin123',
  'iloveyou',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'master',
  'shadow',
  'superman',
  'batman',
  'trustno1',
  'login',
  'passw0rd',
  'p@ssw0rd',
  'qwertyuiop',
  '1q2w3e4r',
  'zaq12wsx',
  'changeme',
  'secret',
  'starwars',
  'whatever',
  'freedom',
  'ninja',
  'azerty',
  'asdfghjkl',
]);

/** True when the password is one of the well-known common passwords. */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

function sha1Suffix(password: string): { prefix: string; suffix: string } {
  const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return { prefix: hash.slice(0, 5), suffix: hash.slice(5) };
}

async function isPwnedOnline(password: string): Promise<boolean> {
  const { prefix, suffix } = sha1Suffix(password);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PWNED_TIMEOUT_MS);

  try {
    const response = await fetch(`${PWNED_RANGE_URL}/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Chatrix' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }

    const body = await response.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':');
      if (hashSuffix?.toUpperCase() === suffix && Number(count) > 0) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.warn(
      'Compromised-password check failed, allowing password:',
      error instanceof Error ? error.message : error,
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns true when the password is known to be compromised. The local list is
 * always applied; the online lookup is gated by `PWNED_PASSWORD_CHECK_ENABLED`
 * and fails open on any network/API error.
 */
export async function isPasswordCompromised(password: string): Promise<boolean> {
  if (isCommonPassword(password)) {
    return true;
  }
  if (!env.PWNED_PASSWORD_CHECK_ENABLED) {
    return false;
  }
  return isPwnedOnline(password);
}
