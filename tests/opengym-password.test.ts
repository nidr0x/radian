import { describe, expect, it } from 'vitest';
import { hashPassword, normalizeEmail, normalizeLoginIdentifier, passwordPolicyError, verifyPassword } from '../functions/lib/radian-api/password-core';

describe('openGym account password rules', () => {
  it('normalizes login names and validates sign-in e-mail the same way as the PWA', () => {
    expect(normalizeLoginIdentifier('  Ａda  ')).toBe('ada');
    expect(normalizeEmail(' ADA@Example.com ')).toBe('ada@example.com');
    expect(normalizeEmail('not an address')).toBeNull();
  });

  it('enforces the web password length policy', () => {
    expect(passwordPolicyError('short')).toBe('too-short');
    expect(passwordPolicyError('a'.repeat(257))).toBe('too-long');
    expect(passwordPolicyError('correct horse battery staple')).toBeNull();
  });

  it('stores a salted scrypt verifier and rejects a different password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });
});
