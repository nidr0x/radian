import { enforceAuthRateLimit, getAuthenticatedContext, issueSessionCookie, json } from '../../lib/auth';
import type { SyncContext } from '../../types';
import { getAccountSecurity, getPasskeyCount, passwordLoginEnabled, verifyOwnerProof } from '../../lib/radian-api/account-security';
import { normalizeLoginIdentifier, hashPassword, passwordPolicyError } from '../../lib/radian-api/password-core';
import { readSmallJson } from '../../lib/radian-api/request';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const passkeys = await getPasskeyCount(authenticated.env.DB!, authenticated.user.id);
  if (!passwordLoginEnabled(context)) {
    return json({ set: false, setAt: null, passkeys, name: authenticated.user.displayName, nameTaken: false, email: null });
  }
  try {
    const security = await getAccountSecurity(authenticated.env.DB!, authenticated.user.id);
    const nameKey = normalizeLoginIdentifier(authenticated.user.displayName);
    const conflict = await authenticated.env.DB!.prepare(
      "SELECT account_id FROM gym_login_identifiers WHERE identifier_key = ? AND kind = 'name' AND account_id <> ?",
    ).bind(nameKey, authenticated.user.id).first<{ accountId: string }>();
    return json({
      set: !!security?.passwordHash,
      setAt: security?.passwordSetAt ?? null,
      passkeys,
      name: authenticated.user.displayName,
      nameTaken: !!conflict,
      email: security?.email ?? null,
    });
  } catch {
    return error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
};

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  if (!passwordLoginEnabled(context)) return error(404, 'password-disabled', 'Password sign-in is disabled.');
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'account-password', authenticated.user.id);
  if (limited) return limited;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const body = read.value;
  const next = typeof body.next === 'string' ? body.next : '';
  if (!next) return error(400, 'missing', 'A new password is required.');
  const policy = passwordPolicyError(next);
  if (policy) return error(400, policy, policy === 'too-common' ? 'This password is too easy to guess.' : 'The password does not meet the length policy.');

  const database = authenticated.env.DB!;
  try {
    const security = await getAccountSecurity(database, authenticated.user.id);
    const passkeyCount = await getPasskeyCount(database, authenticated.user.id);
    const proof = await verifyOwnerProof(authenticated, security, passkeyCount, body);
    if (proof !== 'ok') {
      return error(403, proof, proof === 'current-required' ? 'Your current password is required.' : 'Your account could not be confirmed.');
    }

    const nameKey = normalizeLoginIdentifier(authenticated.user.displayName);
    const conflict = await database.prepare(
      "SELECT account_id FROM gym_login_identifiers WHERE identifier_key = ? AND kind = 'name' AND account_id <> ?",
    ).bind(nameKey, authenticated.user.id).first<{ accountId: string }>();
    if (conflict) return error(409, 'name-taken', 'Another profile already signs in with this name.');

    const passwordHash = await hashPassword(next);
    const setAt = new Date().toISOString();
    const previousHash = security?.passwordHash ?? null;
    const results = await database.batch([
      database.prepare('INSERT OR IGNORE INTO gym_account_security (account_id) VALUES (?)').bind(authenticated.user.id),
      database.prepare("DELETE FROM gym_login_identifiers WHERE account_id = ? AND kind = 'name'").bind(authenticated.user.id),
      database.prepare("INSERT INTO gym_login_identifiers (identifier_key, account_id, kind, value) VALUES (?, ?, 'name', ?)").bind(nameKey, authenticated.user.id, authenticated.user.displayName),
      database.prepare(
        'UPDATE gym_account_security SET password_hash = ?, password_set_at = ? WHERE account_id = ? AND password_hash IS ?',
      ).bind(passwordHash, setAt, authenticated.user.id, previousHash),
      database.prepare(
        'UPDATE users SET session_version = session_version + 1 WHERE id = ? AND EXISTS (SELECT 1 FROM gym_account_security WHERE account_id = ? AND password_hash = ?)',
      ).bind(authenticated.user.id, authenticated.user.id, passwordHash),
      database.prepare('DELETE FROM gym_device_link_codes WHERE account_id = ?').bind(authenticated.user.id),
    ]);
    if ((results[3]?.meta?.changes ?? 0) !== 1 || (results[4]?.meta?.changes ?? 0) !== 1) {
      return error(409, 'credentials-changed', 'The account changed while the password was being saved. Try again.');
    }
    const version = await database.prepare('SELECT session_version AS sessionVersion FROM users WHERE id = ?').bind(authenticated.user.id).first<{ sessionVersion: number }>();
    if (!version) return error(503, 'busy', 'The server is busy. Try again in a moment.');
    const cookie = await issueSessionCookie(context, authenticated.user.id, version.sessionVersion);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  } catch (cause) {
    const collision = await database.prepare(
      "SELECT account_id FROM gym_login_identifiers WHERE identifier_key = ? AND kind = 'name' AND account_id <> ?",
    ).bind(normalizeLoginIdentifier(authenticated.user.displayName), authenticated.user.id).first<{ accountId: string }>().catch(() => null);
    if (collision) return error(409, 'name-taken', 'Another profile already signs in with this name.');
    if (cause instanceof Error && cause.message === 'AUTH_CONFIGURATION_INVALID') return error(503, 'busy', 'The server is busy. Try again in a moment.');
    return error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
};

export const onRequestDelete = async (context: SyncContext): Promise<Response> => {
  if (!passwordLoginEnabled(context)) return error(404, 'password-disabled', 'Password sign-in is disabled.');
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'account-password-remove', authenticated.user.id);
  if (limited) return limited;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const database = authenticated.env.DB!;
  try {
    const security = await getAccountSecurity(database, authenticated.user.id);
    if (!security?.passwordHash) return json({ ok: true });
    if ((await getPasskeyCount(database, authenticated.user.id)) === 0) {
      return error(409, 'last-way-in', 'The password is the only way into this profile.');
    }
    const proof = await verifyOwnerProof(authenticated, security, 1, read.value);
    if (proof !== 'ok') return error(403, proof, proof === 'current-required' ? 'Your current password is required.' : 'Your account could not be confirmed.');

    const results = await database.batch([
      database.prepare(
        'UPDATE gym_account_security SET password_hash = NULL, password_set_at = NULL WHERE account_id = ? AND password_hash = ?',
      ).bind(authenticated.user.id, security.passwordHash),
      database.prepare(
        "DELETE FROM gym_login_identifiers WHERE account_id = ? AND kind = 'name' AND EXISTS (SELECT 1 FROM gym_account_security WHERE account_id = ? AND password_hash IS NULL)",
      ).bind(authenticated.user.id, authenticated.user.id),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) return error(409, 'credentials-changed', 'The account changed while the password was being removed. Try again.');
    return json({ ok: true });
  } catch {
    return error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
};
