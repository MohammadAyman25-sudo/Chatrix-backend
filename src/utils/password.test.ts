import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, isPasswordValid, validatePasswordPolicy } from './password.js';

describe('validatePasswordPolicy', () => {
  it('accepts a password with all required character classes', () => {
    expect(validatePasswordPolicy('Str0ng!Pass')).toEqual([]);
    expect(isPasswordValid('Str0ng!Pass')).toBe(true);
  });

  it('requires a lowercase Latin letter', () => {
    expect(validatePasswordPolicy('STR0NG!PASS')).toContainEqual(
      expect.stringContaining('lowercase'),
    );
  });

  it('requires an uppercase Latin letter', () => {
    expect(validatePasswordPolicy('str0ng!pass')).toContainEqual(
      expect.stringContaining('uppercase'),
    );
  });

  it('requires a number', () => {
    expect(validatePasswordPolicy('Strong!Pass')).toContainEqual(expect.stringContaining('number'));
  });

  it('requires a special symbol', () => {
    expect(validatePasswordPolicy('Str0ngPass')).toContainEqual(
      expect.stringContaining('special symbol'),
    );
  });

  it('rejects passwords shorter than the minimum length', () => {
    expect(validatePasswordPolicy('Ab1!')).toContainEqual(expect.stringContaining('at least 8'));
  });

  it('rejects passwords longer than the bcrypt limit', () => {
    const tooLong = `Aa1!${'x'.repeat(PASSWORD_MAX_LENGTH)}`;
    expect(validatePasswordPolicy(tooLong)).toContainEqual(
      expect.stringContaining(`at most ${PASSWORD_MAX_LENGTH}`),
    );
  });

  it('rejects non-Latin characters', () => {
    // "Пароль1A!" is composed of Cyrillic letters plus the required classes.
    expect(validatePasswordPolicy('Пароль1A!')).toContainEqual(
      expect.stringContaining('Latin letters'),
    );
  });

  it('rejects spaces', () => {
    expect(validatePasswordPolicy('Str0ng !Pass')).toContainEqual(
      expect.stringContaining('Latin letters'),
    );
  });
});
