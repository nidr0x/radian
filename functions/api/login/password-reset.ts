import { enforceAuthRateLimit, getAccountRoles, issueSessionCookie, json, requireDatabase } from '../../lib/auth';
import { normalizeEmail, normalizeLoginIdentifier, hashPassword, passwordPolicyError } from '../../lib/radian-api/password-core';
import { auditStatement } from '../../lib/radian-api/admin';
import { hashCode, normalizeOneTimeCode, validOneTimeCode } from '../../lib/radian-api/one-time-code';
import { readSmallJson } from '../../lib/radian-api/request';
import type { SyncContext } from '../../types';

interface ResetProfile {
  id: string;
  displayName: string;
  createdAt: string;
  disabled: number;
  email: string | null;
}

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  if (context.env.PASSWORD_LOGIN !== '1') return error(404, 'password-disabled', 'Password sign-in is disabled.');
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const limited = await enforceAuthRateLimit(context, 'password-reset-ip');
  if (limited) return limited;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const body = read.value;
  const rawCode = typeof body.code === 'string' ? normalizeOneTimeCode(body.code) : '';
  const next = typeof body.next === 'string' ? body.next : '';
  if (!rawCode || !next) return error(400, 'missing', 'A reset code and new password are required.');
  const policy = passwordPolicyError(next);
  if (policy) return error(400, policy, policy === 'too-common' ? 'This password is too easy to guess.' : 'The password does not meet the length policy.');
  if (!validOneTimeCode(rawCode)) return error(400, 'reset-invalid', 'That reset code is wrong or has expired.');

  const typedIdentifier = typeof body.identifier === 'string' ? body.identifier
    : typeof body.name === 'string' ? body.name
      : typeof body.email === 'string' ? body.email : '';
  if (!typedIdentifier.trim()) return error(400, 'missing', 'A profile name or e-mail is required.');
  const emailOnly = typeof body.email === 'string' && typeof body.identifier !== 'string' && typeof body.name !== 'string';
  const codeHash = await hashCode(rawCode);
  const now = new Date().toISOString();
  const profile = await database.prepare(
    `SELECT u.id, u.display_name AS displayName, u.created_at AS createdAt,
            u.disabled, s.email
       FROM gym_password_reset_codes c JOIN users u ON u.id = c.account_id
       LEFT JOIN gym_account_security s ON s.account_id = u.id
      WHERE c.code_hash = ? AND c.used_at IS NULL AND c.expires_at > ?`,
  ).bind(codeHash, now).first<ResetProfile>();
  const inputEmail = normalizeEmail(typedIdentifier);
  const identifierMatches = !!profile && (emailOnly
    ? !!inputEmail && inputEmail === profile.email
    : normalizeLoginIdentifier(typedIdentifier) === normalizeLoginIdentifier(profile.displayName)
      || (!!inputEmail && inputEmail === profile.email));
  if (!profile || !identifierMatches) return error(400, 'reset-invalid', 'That reset code is wrong or has expired.');
  if (profile.disabled === 1) return error(403, 'disabled', 'This account has been disabled.');

  const nameKey = normalizeLoginIdentifier(profile.displayName);
  const conflict = await database.prepare(
    "SELECT account_id FROM gym_login_identifiers WHERE identifier_key = ? AND kind = 'name' AND account_id <> ?",
  ).bind(nameKey, profile.id).first<{ accountId: string }>();
  if (conflict) return error(409, 'name-taken', 'Another profile already signs in with this name.');

  const passwordHash = await hashPassword(next);
  const statements = [
    database.prepare(
      `UPDATE gym_password_reset_codes SET used_at = ?
        WHERE account_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?
          AND EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled = 0)`,
    ).bind(now, profile.id, codeHash, now, profile.id),
    database.prepare(
      `INSERT INTO gym_login_identifiers (identifier_key, account_id, kind, value)
       SELECT ?, ?, 'name', ? WHERE changes() = 1 AND EXISTS (
         SELECT 1 FROM gym_password_reset_codes WHERE account_id = ? AND code_hash = ? AND used_at = ?
       ) ON CONFLICT(account_id, kind) DO UPDATE SET identifier_key = excluded.identifier_key, value = excluded.value`,
    ).bind(nameKey, profile.id, profile.displayName, profile.id, codeHash, now),
    database.prepare(
      `UPDATE gym_account_security SET password_hash = ?, password_set_at = ?
        WHERE account_id = ? AND changes() = 1 AND EXISTS (
          SELECT 1 FROM gym_password_reset_codes WHERE account_id = ? AND code_hash = ? AND used_at = ?
        )`,
    ).bind(passwordHash, now, profile.id, profile.id, codeHash, now),
    database.prepare(
      `UPDATE users SET session_version = session_version + 1 WHERE id = ? AND EXISTS (
        SELECT 1 FROM gym_account_security WHERE account_id = ? AND password_hash = ?
      ) AND changes() = 1 AND EXISTS (
        SELECT 1 FROM gym_password_reset_codes WHERE account_id = ? AND code_hash = ? AND used_at = ?
      )`,
    ).bind(profile.id, profile.id, passwordHash, profile.id, codeHash, now),
    database.prepare(
      `DELETE FROM gym_device_link_codes WHERE account_id = ? AND changes() = 1 AND EXISTS (
        SELECT 1 FROM gym_password_reset_codes WHERE account_id = ? AND code_hash = ? AND used_at = ?
      )`,
    ).bind(profile.id, profile.id, codeHash, now),
  ];
  let results;
  try { results = await database.batch(statements); }
  catch {
    const nameConflict = await database.prepare(
      "SELECT account_id FROM gym_login_identifiers WHERE identifier_key = ? AND kind = 'name' AND account_id <> ?",
    ).bind(nameKey, profile.id).first<{ accountId: string }>().catch(() => null);
    return nameConflict
      ? error(409, 'name-taken', 'Another profile already signs in with this name.')
      : error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1
    || (results[2]?.meta?.changes ?? 0) !== 1 || (results[3]?.meta?.changes ?? 0) !== 1) {
    return error(400, 'reset-invalid', 'That reset code is wrong or has expired.');
  }

  const audit = auditStatement(database, context, { id: profile.id, displayName: profile.displayName }, 'auth.password.reset');
  if (audit) await audit.run().catch(() => {});
  const version = await database.prepare('SELECT session_version AS sessionVersion FROM users WHERE id = ?').bind(profile.id).first<{ sessionVersion: number }>();
  if (!version) return error(503, 'busy', 'The server is busy. Try again in a moment.');
  try {
    const cookie = await issueSessionCookie(context, profile.id, version.sessionVersion);
    const roles = await getAccountRoles(database, profile.id, context.env);
    return json({ user: { id: profile.id, name: profile.displayName, created: profile.createdAt, ...roles } }, 200, { 'Set-Cookie': cookie });
  } catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
};
