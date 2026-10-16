import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCommonPassword, isPasswordCompromised } from './pwned.js';

function sha1(password: string): { prefix: string; suffix: string } {
  const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return { prefix: hash.slice(0, 5), suffix: hash.slice(5) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isCommonPassword', () => {
  it('matches the bundled list case-insensitively', () => {
    expect(isCommonPassword('password')).toBe(true);
    expect(isCommonPassword('PASSWORD')).toBe(true);
    expect(isCommonPassword('correct-horse-battery-staple-42')).toBe(false);
  });
});

describe('isPasswordCompromised', () => {
  it('flags a common password without calling the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(isPasswordCompromised('password')).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flags a password found in the Pwned Passwords range response', async () => {
    const password = 'Correct-Horse-1!';
    const { prefix, suffix } = sha1(password);
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
      return new Response(`0000000000000000000000000000000000A:1\n${suffix}:42\n`, {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(isPasswordCompromised(password)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows a password that does not appear in the range response', async () => {
    const password = 'Unique-Strong-1!';
    const fetchMock = vi.fn(
      async () => new Response('0000000000000000000000000000000000A:1\n', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(isPasswordCompromised(password)).resolves.toBe(false);
  });

  it('fails open when the API errors', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(isPasswordCompromised('Unique-Strong-1!')).resolves.toBe(false);
  });

  it('fails open when the API returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    await expect(isPasswordCompromised('Unique-Strong-1!')).resolves.toBe(false);
  });
});
