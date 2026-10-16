/**
 * Password policy shared by the registration schema and tests.
 *
 * Requirements: at least one lowercase Latin letter, one uppercase Latin letter,
 * one number and one special symbol. Only Latin letters, digits and the special
 * symbols below are accepted (no other Unicode), and the length is bounded so it
 * fits bcrypt's 72-byte limit.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

/** Special symbols allowed in passwords (everything else must be alphanumeric). */
export const ALLOWED_SPECIAL_CHARACTERS = `!@#$%^&*()_+-=[]{};':"\\|,.<>/?\`~`;

const HAS_LOWERCASE = /[a-z]/;
const HAS_UPPERCASE = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;
const HAS_SPECIAL = /[^A-Za-z0-9]/;
const ALLOWED_CHARACTERS = /^[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]+$/;

/**
 * Returns a list of human-readable violations; an empty array means the password
 * satisfies the policy.
 */
export function validatePasswordPolicy(password: string): string[] {
  const errors: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    errors.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters long`);
  }
  if (!HAS_LOWERCASE.test(password)) {
    errors.push('Password must contain at least one lowercase Latin letter (a-z)');
  }
  if (!HAS_UPPERCASE.test(password)) {
    errors.push('Password must contain at least one uppercase Latin letter (A-Z)');
  }
  if (!HAS_DIGIT.test(password)) {
    errors.push('Password must contain at least one number (0-9)');
  }
  if (!HAS_SPECIAL.test(password)) {
    errors.push('Password must contain at least one special symbol (e.g. !@#$%^&*)');
  }
  if (!ALLOWED_CHARACTERS.test(password)) {
    errors.push(
      'Password may only contain Latin letters, numbers and special symbols (no other characters)',
    );
  }

  return errors;
}

/** Convenience boolean wrapper around `validatePasswordPolicy`. */
export function isPasswordValid(password: string): boolean {
  return validatePasswordPolicy(password).length === 0;
}
