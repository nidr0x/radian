import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_BYTES = 64;
const SCRYPT_MAXMEM = 32 * 1024 * 1024;
const DUMMY_SALT = Buffer.from('radian-password-dummy-salt');
const COMMON_PASSWORDS = new Set(['password123', '1234567890', 'qwerty12345', 'letmein1234', 'iloveyou123']);
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@(?=.{1,253}$)[^\s@<>()[\]\\,;:"._-][^\s@<>()[\]\\,;:]*\.[^\s@<>()[\]\\,;:".]{2,}$/u;

const derive = (password: string, salt: Uint8Array): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCallback(password, salt, SCRYPT_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }, (error, key) => error ? reject(error) : resolve(key));
});

export const normalizeLoginIdentifier = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

export const normalizeEmail = (value: string): string | null => {
  const email = normalizeLoginIdentifier(value);
  return [...email].length <= 254 && EMAIL_RE.test(email) && !email.includes('..') ? email : null;
};

export const passwordPolicyError = (value: string): 'too-short' | 'too-long' | 'too-common' | null => {
  const length = [...value].length;
  if (length < 10) return 'too-short';
  if (length > 256) return 'too-long';
  return COMMON_PASSWORDS.has(value.normalize('NFKC').toLowerCase()) ? 'too-common' : null;
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const digest = await derive(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
};

export const verifyPassword = async (password: string, encoded: string | null | undefined): Promise<boolean> => {
  const parts = encoded?.split('$') ?? [];
  if (parts.length !== 6 || parts[0] !== 'scrypt'
      || parts[1] !== String(SCRYPT_N) || parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)) {
    await derive(password, DUMMY_SALT);
    return false;
  }
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const candidate = await derive(password, salt);
    return expected.length === candidate.length && timingSafeEqual(candidate, expected);
  } catch {
    await derive(password, DUMMY_SALT);
    return false;
  }
};
