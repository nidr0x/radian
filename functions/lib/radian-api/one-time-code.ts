import type { D1DatabaseLike } from '../../types';

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface ActiveInvite {
  code: string;
  codeHash: string;
}

export const normalizeOneTimeCode = (value: string): string => value.toUpperCase().replace(/[\s-]/g, '');

export const createOneTimeCode = (): { value: string; display: string } => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const value = Array.from(bytes, (byte) => CODE_ALPHABET[byte & 31]).join('');
  return { value, display: `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}` };
};

export const validOneTimeCode = (value: string): boolean => /^[0-9A-HJKMNPQRSTVWXYZ]{12}$/.test(value);

export const createInviteCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
};

export const normalizeInviteCode = (value: string): string => value.toUpperCase().replace(/[\s-]/g, '');

export const findActiveInvite = async (database: D1DatabaseLike, value: string): Promise<ActiveInvite | null> => {
  const code = normalizeInviteCode(value);
  if (!/^[A-F0-9]{16}$/.test(code)) return null;
  const codeHash = await hashCode(code);
  return database.prepare('SELECT code, code_hash AS codeHash FROM gym_invites WHERE code_hash = ? AND used_at IS NULL')
    .bind(codeHash).first<ActiveInvite>();
};

export const hashCode = async (value: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
